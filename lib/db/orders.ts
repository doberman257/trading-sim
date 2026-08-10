import { and, asc, desc, eq } from "drizzle-orm";
import { fetchQuote, NoTwoSidedQuoteError } from "../market/alpaca";
import { executeMarketOrder } from "../trading/execute";
import { canPlaceLimitOrder, type PendingLimitOrder } from "../trading/limit-reservation";
import type { Cents } from "../trading/money";
import type {
  CancelOrderResult,
  Fill,
  OrderResult,
  PlaceLimitOrderResult,
  Side,
} from "../trading/types";
import { getOrCreateAccount, loadAccountState } from "./accounts";
import { db, type DbTransaction } from "./client";
import type { OrderStatus } from "./portfolio";
import { accounts, orders, positions, transactions } from "./schema";

// The tail end of applying any fill - market or limit - to an account:
// update cash, then upsert or delete the position depending on whether any
// of it remains. Shared by placeMarketOrder below and the limit-order
// worker (lib/db/limit-order-worker.ts), which both reach this same
// state-mutation step after a different route to deciding a fill should
// happen at all.
export async function applyFillEffects(
  tx: DbTransaction,
  accountId: string,
  symbol: string,
  fill: Fill,
): Promise<void> {
  await tx.update(accounts).set({ cashCents: fill.newCashCents }).where(eq(accounts.id, accountId));

  if (fill.newPosition) {
    await tx
      .insert(positions)
      .values({
        accountId,
        symbol,
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
      .where(and(eq(positions.accountId, accountId), eq(positions.symbol, symbol)));
  }
}

// The ledger entry for a fill - also shared between placeMarketOrder and
// the limit-order worker, same reasoning as applyFillEffects above.
export async function recordFillTransaction(
  tx: DbTransaction,
  accountId: string,
  orderId: string,
  side: Side,
  fill: Fill,
): Promise<void> {
  await tx.insert(transactions).values({
    accountId,
    orderId,
    kind: side,
    amountCents: side === "buy" ? -fill.totalCents : fill.totalCents,
    balanceAfterCents: fill.newCashCents,
  });
}

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

    await applyFillEffects(tx, lockedAccount.id, quote.symbol, fill);
    await recordFillTransaction(tx, lockedAccount.id, insertedOrder.id, side, fill);

    return result;
  });
}

// Every pending limit order on an account, regardless of symbol - what
// canPlaceLimitOrder (lib/trading/limit-reservation.ts) needs to compute
// how much cash/shares are already claimed before deciding whether a new
// one fits. Takes a transaction, not the bare `db` client: this must be
// read from inside the same locked transaction that's about to insert the
// new order, so the reservation total is against a consistent snapshot -
// see placeLimitOrder below.
export async function getPendingLimitOrdersForAccount(
  tx: DbTransaction,
  accountId: string,
): Promise<PendingLimitOrder[]> {
  const rows = await tx
    .select({
      side: orders.side,
      symbol: orders.symbol,
      quantity: orders.quantity,
      limitPriceCents: orders.limitPriceCents,
    })
    .from(orders)
    .where(
      and(eq(orders.accountId, accountId), eq(orders.status, "pending"), eq(orders.type, "limit")),
    );

  return rows.map((row) => {
    // limitPriceCents is a nullable column only because market orders
    // never set it - every row this query can return is already filtered
    // to type: "limit", which always sets it at insert time (see
    // placeLimitOrder), so null here would mean the schema's own
    // invariant broke, not a normal case to route through PendingLimitOrder.
    if (row.limitPriceCents === null) {
      throw new Error(`Pending limit order for account ${accountId} is missing limitPriceCents`);
    }
    return {
      side: row.side,
      symbol: row.symbol,
      quantity: row.quantity,
      limitPriceCents: row.limitPriceCents,
    };
  });
}

export type PlaceLimitOrderInput = {
  userId: string;
  symbol: string;
  side: Side;
  quantity: number;
  limitPriceCents: Cents;
};

// Unlike placeMarketOrder, this never touches Alpaca - a limit order's
// whole point is to wait for a price condition, not to execute against a
// quote right now (see lib/trading/limit-reservation.ts's own note on why
// canPlaceLimitOrder doesn't check market hours or fetch a quote either).
// The only thing checked here is solvency: is there real room for this
// commitment once every other resting order's own claim on the same
// cash/shares is accounted for.
export async function placeLimitOrder({
  userId,
  symbol,
  side,
  quantity,
  limitPriceCents,
}: PlaceLimitOrderInput): Promise<PlaceLimitOrderResult> {
  const account = await getOrCreateAccount(userId);

  return db.transaction(async (tx) => {
    // Same lock placeMarketOrder takes, for the same reason: without it,
    // two concurrent limit-order placements could both read the same
    // "other pending orders" total and both accept commitments that,
    // together, overcommit the account - the second transaction's SELECT
    // blocks until the first COMMITs, so it always computes reservations
    // against the post-first-order state.
    const [lockedAccount] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, account.id))
      .for("update");

    if (!lockedAccount) {
      throw new Error(`Account ${account.id} not found`);
    }

    const accountState = await loadAccountState(tx, lockedAccount.id);
    const otherPendingOrders = await getPendingLimitOrdersForAccount(tx, lockedAccount.id);

    const decision = canPlaceLimitOrder(
      accountState,
      { side, symbol, quantity, limitPriceCents },
      otherPendingOrders,
    );

    if (!decision.ok) {
      // A rejected order is still a record worth keeping, same as
      // placeMarketOrder's own rejections.
      await tx.insert(orders).values({
        accountId: lockedAccount.id,
        symbol,
        side,
        type: "limit",
        quantity,
        limitPriceCents,
        status: "rejected",
        rejectReason: decision.reason,
      });

      return decision;
    }

    const [insertedOrder] = await tx
      .insert(orders)
      .values({
        accountId: lockedAccount.id,
        symbol,
        side,
        type: "limit",
        quantity,
        limitPriceCents,
        status: "pending",
      })
      .returning({ id: orders.id });

    if (!insertedOrder) {
      throw new Error("Failed to insert pending limit order");
    }

    return { ok: true, orderId: insertedOrder.id };
  });
}

// Cancels a pending limit order - or reports why it couldn't be. Locks the
// order row itself, not the account row: this is the exact same lock
// primitive the worker's own claim step uses (see
// lib/db/limit-order-worker.ts), specifically so a user's cancellation and
// the worker's fill attempt on the same order are a genuine race decided
// by whichever transaction's SELECT ... FOR UPDATE gets there first, not
// by two independent, uncoordinated checks that could both "succeed."
//
// Scoped to accountId in the same WHERE as the id, not checked afterward -
// an order id that exists but belongs to a different account must look
// identical to one that doesn't exist at all, so this never confirms or
// denies which case it was.
export async function cancelOrder(userId: string, orderId: string): Promise<CancelOrderResult> {
  const account = await getOrCreateAccount(userId);

  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.accountId, account.id)))
      .for("update");

    if (!order) {
      return { ok: false, reason: "not_found" };
    }

    if (order.status === "filled") {
      return { ok: false, reason: "already_filled" };
    }

    if (order.status !== "pending") {
      return { ok: false, reason: "not_cancellable" };
    }

    await tx.update(orders).set({ status: "cancelled" }).where(eq(orders.id, order.id));

    return { ok: true };
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

export type PendingOrderForDisplay = {
  id: string;
  symbol: string;
  side: Side;
  quantity: number;
  limitPriceCents: Cents;
  createdAt: Date;
};

// A distinct read from getPendingLimitOrdersForAccount above: that one is
// transaction-scoped and returns only what canPlaceLimitOrder's
// reservation math needs (no id, no timestamp). This one is for display -
// the dashboard and stock detail page's own pending-orders panel, with a
// real id (for the cancel button) and createdAt (oldest first, matching
// how the worker itself drains its own queue) - see
// components/PendingOrdersPanel.tsx.
export async function getPendingOrdersForAccount(
  accountId: string,
  symbol?: string,
): Promise<PendingOrderForDisplay[]> {
  const conditions = [
    eq(orders.accountId, accountId),
    eq(orders.status, "pending"),
    eq(orders.type, "limit"),
  ];
  if (symbol) {
    conditions.push(eq(orders.symbol, symbol));
  }

  const rows = await db
    .select({
      id: orders.id,
      symbol: orders.symbol,
      side: orders.side,
      quantity: orders.quantity,
      limitPriceCents: orders.limitPriceCents,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(and(...conditions))
    .orderBy(asc(orders.createdAt));

  return rows.map((row) => {
    if (row.limitPriceCents === null) {
      throw new Error(`Pending limit order ${row.id} is missing limitPriceCents`);
    }
    return {
      id: row.id,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      limitPriceCents: row.limitPriceCents,
      createdAt: row.createdAt,
    };
  });
}

export type OrderForDisplay = {
  id: string;
  symbol: string;
  side: Side;
  type: "market" | "limit";
  quantity: number;
  status: OrderStatus;
  limitPriceCents: Cents | null;
  filledPriceCents: Cents | null;
  rejectReason: string | null;
  createdAt: Date;
  filledAt: Date | null;
};

// A generous but bounded page, not the full history - GET /api/orders
// (app/api/orders/route.ts) is the one consumer today, and this keeps that
// route's response size predictable regardless of how long an account has
// been trading.
const ORDERS_LIST_LIMIT = 50;

// A third, distinct order-reading query, deliberately not a reuse of
// getPortfolio's recentOrders (dashboard-shaped, no type/limitPriceCents,
// capped differently) or getPendingLimitOrdersForAccount (reservation-math-
// shaped, transaction-scoped, no id). This one exists for GET /api/orders
// specifically - a bot or script asking "what are my orders" needs the
// complete shape (including whether an order was a market or limit order,
// and its limit price if any), not whatever subset a different consumer
// happened to already need.
export async function getOrdersForAccount(
  accountId: string,
  options?: { status?: OrderStatus },
): Promise<OrderForDisplay[]> {
  const conditions = [eq(orders.accountId, accountId)];
  if (options?.status) {
    conditions.push(eq(orders.status, options.status));
  }

  const rows = await db
    .select({
      id: orders.id,
      symbol: orders.symbol,
      side: orders.side,
      type: orders.type,
      quantity: orders.quantity,
      status: orders.status,
      limitPriceCents: orders.limitPriceCents,
      filledPriceCents: orders.filledPriceCents,
      rejectReason: orders.rejectReason,
      createdAt: orders.createdAt,
      filledAt: orders.filledAt,
    })
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt))
    .limit(ORDERS_LIST_LIMIT);

  return rows;
}
