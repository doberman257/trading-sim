import { and, asc, eq } from "drizzle-orm";
import { fetchQuote, NoTwoSidedQuoteError } from "../market/alpaca";
import { executeMarketOrder } from "../trading/execute";
import type { OrderResult, Side } from "../trading/types";
import { getOrCreateAccount, loadAccountState } from "./accounts";
import { db } from "./client";
import { accounts, orders, positions, transactions } from "./schema";

export type PlaceMarketOrderInput = {
  userId: string;
  symbol: string;
  side: Side;
  quantity: number;
};

export async function placeMarketOrder({
  userId,
  symbol,
  side,
  quantity,
}: PlaceMarketOrderInput): Promise<OrderResult> {
  // Never hold a DB transaction open across a network call: fetch the quote
  // and resolve the account before opening the transaction below. Kept as
  // two separate awaits, not Promise.all, so a NoTwoSidedQuoteError from
  // fetchQuote can be caught on its own without also needing to guard
  // against getOrCreateAccount throwing for an unrelated reason.
  const accountPromise = getOrCreateAccount(userId);

  let quote;
  try {
    quote = await fetchQuote(symbol);
  } catch (error) {
    if (!(error instanceof NoTwoSidedQuoteError)) {
      throw error;
    }

    // A missing two-sided quote is a normal, expected market condition
    // (most often the market being closed), not a config error like a bad
    // API key - it gets the same "rejected order, still logged" treatment
    // as insufficient_funds/insufficient_shares below, not an unhandled
    // throw. CLAUDE.md: order rejection is a normal outcome, not an
    // exception.
    const account = await accountPromise;
    return db.transaction(async (tx) => {
      await tx.insert(orders).values({
        accountId: account.id,
        symbol,
        side,
        type: "market",
        quantity,
        status: "rejected",
        rejectReason: "no_quote",
      });
      return { ok: false, reason: "no_quote" };
    });
  }

  const account = await accountPromise;

  return db.transaction(async (tx) => {
    // Lock the account row before reading its balance. Without this, two
    // concurrent orders can both read the same cash balance, both pass the
    // funds check, and both write an update based on that stale balance -
    // the second UPDATE overwrites the first instead of building on it, so
    // the account is silently short-charged. FOR UPDATE forces the second
    // transaction's SELECT to block until the first COMMITs, so it always
    // computes against the post-first-order balance.
    const [lockedAccount] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, account.id))
      .for("update");

    if (!lockedAccount) {
      throw new Error(`Account ${account.id} not found`);
    }

    const accountState = await loadAccountState(tx, lockedAccount.id);
    const result = executeMarketOrder(accountState, quote, side, quantity);

    if (!result.ok) {
      // A rejected order is still a record worth keeping.
      await tx.insert(orders).values({
        accountId: lockedAccount.id,
        symbol: quote.symbol,
        side,
        type: "market",
        quantity,
        status: "rejected",
        rejectReason: result.reason,
      });

      return result;
    }

    const { fill } = result;

    const [insertedOrder] = await tx
      .insert(orders)
      .values({
        accountId: lockedAccount.id,
        symbol: quote.symbol,
        side,
        type: "market",
        quantity,
        status: "filled",
        filledPriceCents: fill.priceCents,
        filledAt: new Date(),
      })
      .returning({ id: orders.id });

    if (!insertedOrder) {
      throw new Error("Failed to insert filled order");
    }

    await tx
      .update(accounts)
      .set({ cashCents: fill.newCashCents })
      .where(eq(accounts.id, lockedAccount.id));

    if (fill.newPosition) {
      await tx
        .insert(positions)
        .values({
          accountId: lockedAccount.id,
          symbol: quote.symbol,
          quantity: fill.newPosition.quantity,
          avgCostCents: fill.newPosition.avgCostCents,
        })
        .onConflictDoUpdate({
          target: [positions.accountId, positions.symbol],
          set: {
            quantity: fill.newPosition.quantity,
            avgCostCents: fill.newPosition.avgCostCents,
          },
        });
    } else {
      await tx
        .delete(positions)
        .where(and(eq(positions.accountId, lockedAccount.id), eq(positions.symbol, quote.symbol)));
    }

    await tx.insert(transactions).values({
      accountId: lockedAccount.id,
      orderId: insertedOrder.id,
      kind: side,
      amountCents: side === "buy" ? -fill.totalCents : fill.totalCents,
      balanceAfterCents: fill.newCashCents,
    });

    return result;
  });
}

export type SymbolOrderFill = {
  id: string;
  side: Side;
  quantity: number;
  filledPriceCents: bigint;
  filledAt: Date;
};

// Every filled order for one symbol, oldest first - what the stock detail
// page's chart draws trade markers from, and what its Orders tab lists
// (reversed there for newest-first display). Mapping a fill's UTC filledAt
// onto the Eastern trading day it belongs to (see toExchangeDateKey in
// lib/trading/market-hours.ts) is the caller's job, not this query's - this
// stays a plain read.
export async function getFilledOrdersForSymbol(
  accountId: string,
  symbol: string,
): Promise<SymbolOrderFill[]> {
  const rows = await db
    .select({
      id: orders.id,
      side: orders.side,
      quantity: orders.quantity,
      filledPriceCents: orders.filledPriceCents,
      filledAt: orders.filledAt,
    })
    .from(orders)
    .where(
      and(eq(orders.accountId, accountId), eq(orders.symbol, symbol), eq(orders.status, "filled")),
    )
    .orderBy(asc(orders.filledAt));

  return rows.map((row) => {
    // filledPriceCents/filledAt are nullable columns in the schema (null for
    // pending/rejected/cancelled orders) - the "filled" status filter above
    // guarantees both are set for every row here, so this narrows rather
    // than propagating an impossible null case to every caller.
    if (row.filledPriceCents === null || row.filledAt === null) {
      throw new Error(`Filled order for ${symbol} is missing filledPriceCents/filledAt`);
    }
    return {
      id: row.id,
      side: row.side,
      quantity: row.quantity,
      filledPriceCents: row.filledPriceCents,
      filledAt: row.filledAt,
    };
  });
}
