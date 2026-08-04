import { and, eq } from "drizzle-orm";
import { fetchQuote } from "../market/alpaca";
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
  // and resolve the account before opening the transaction below.
  const [quote, account] = await Promise.all([fetchQuote(symbol), getOrCreateAccount(userId)]);

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
