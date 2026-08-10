import { and, asc, desc, eq } from "drizzle-orm";
import { fetchQuotes } from "../market/alpaca";
import { executeMarketOrder } from "../trading/execute";
import { shouldFillLimitOrder } from "../trading/limit-fill";
import { isMarketOpen } from "../trading/market-hours";
import type { Quote } from "../trading/types";
import { loadAccountState } from "./accounts";
import { applyFillEffects, recordFillTransaction } from "./orders";
import { db } from "./client";
import { accounts, limitOrderWorkerRuns, orders } from "./schema";

// A bounded batch, not every pending order in one invocation - keeps each
// run's wall-clock time and lock footprint predictable regardless of how
// many limit orders happen to be resting at once, and means a burst of
// orders drains over a few runs rather than risking one invocation timing
// out partway through. Oldest first (see the query below), so a large
// backlog drains in the order it was placed rather than an arbitrary one.
const MAX_ORDERS_PER_RUN = 100;

export type LimitOrderWorkerRunCounts = {
  marketWasOpen: boolean;
  ordersEvaluated: number;
  ordersFilled: number;
  ordersExpired: number;
};

export type LimitOrderWorkerOutcome =
  { ok: true; counts: LimitOrderWorkerRunCounts } | { ok: false; error: string };

// The single entry point app/api/worker/limit-orders/route.ts calls. Must
// be safe under IRREGULAR invocation - no assumption of a fixed interval,
// that the previous run happened, or that it ran during market hours. Two
// runs a minute apart and two runs a day apart must both leave the system
// in a correct state, which is why every decision here is a pure function
// of "what is true right now" (today's market status, each order's own
// current status under its own lock) rather than anything relative to
// when this worker last ran.
export async function runLimitOrderWorker(now: Date): Promise<LimitOrderWorkerOutcome> {
  const [run] = await db
    .insert(limitOrderWorkerRuns)
    .values({})
    .returning({ id: limitOrderWorkerRuns.id });

  if (!run) {
    throw new Error("Failed to record a new limit_order_worker_runs row");
  }

  try {
    const counts = isMarketOpen(now)
      ? await fillEligibleOrders(now)
      : await expireAllPendingOrders();

    await db
      .update(limitOrderWorkerRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
        marketWasOpen: counts.marketWasOpen,
        ordersEvaluated: counts.ordersEvaluated,
        ordersFilled: counts.ordersFilled,
        ordersExpired: counts.ordersExpired,
      })
      .where(eq(limitOrderWorkerRuns.id, run.id));

    return { ok: true, counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(limitOrderWorkerRuns)
      .set({ status: "failed", finishedAt: new Date(), errorMessage: message })
      .where(eq(limitOrderWorkerRuns.id, run.id));

    return { ok: false, error: message };
  }
}

// Day orders only: any invocation that finds the market closed sweeps
// EVERY pending limit order to "expired", unconditionally - not just ones
// placed earlier today. This is what stays correct without knowing
// anything about scheduling history: distinguishing "placed today, should
// survive to tomorrow's session" from "placed weeks ago and should have
// expired already" would need extra bookkeeping this design deliberately
// avoids, in exchange for a simple, always-correct rule that a pending
// limit order is only ever "resting" during the single continuous open
// session it's checked in. The practical effect: placing a limit order
// while the market is closed is accepted (see placeLimitOrder), but it
// will be expired the next time this worker runs while still closed,
// which - depending on the scheduler's cadence - may be within minutes,
// not preserved until the next open. See STATE.md for this tradeoff.
async function expireAllPendingOrders(): Promise<LimitOrderWorkerRunCounts> {
  const expired = await db.transaction(async (tx) => {
    return tx
      .update(orders)
      .set({ status: "expired" })
      .where(and(eq(orders.status, "pending"), eq(orders.type, "limit")))
      .returning({ id: orders.id });
  });

  return {
    marketWasOpen: false,
    ordersEvaluated: 0,
    ordersFilled: 0,
    ordersExpired: expired.length,
  };
}

async function fillEligibleOrders(now: Date): Promise<LimitOrderWorkerRunCounts> {
  // Deliberately unlocked: this is only used to pick which order ids to
  // attempt this run. The authoritative check happens per-order below,
  // after each one's own row lock is acquired - a candidate picked up here
  // that a user cancels a moment later is simply skipped there, not acted
  // on based on this stale read.
  const candidates = await db
    .select({ id: orders.id, symbol: orders.symbol })
    .from(orders)
    .where(and(eq(orders.status, "pending"), eq(orders.type, "limit")))
    .orderBy(asc(orders.createdAt))
    .limit(MAX_ORDERS_PER_RUN);

  // One batched quote request for every distinct symbol in this batch, not
  // one fetchQuote call per order - the same batching discipline
  // fetchQuotes already documents for a portfolio's worth of positions.
  // fetchQuotes also already excludes any zero-priced (invalid) side on
  // its own, so a symbol with no genuine two-sided quote right now simply
  // isn't in the map below, and its order is skipped this round exactly
  // like a symbol Alpaca has no data for at all.
  const uniqueSymbols = [...new Set(candidates.map((candidate) => candidate.symbol))];
  const { quotes } = await fetchQuotes(uniqueSymbols);

  let ordersFilled = 0;

  for (const candidate of candidates) {
    const quote = quotes.get(candidate.symbol);
    if (!quote) continue;

    const filled = await tryFillOneOrder(candidate.id, quote, now);
    if (filled) ordersFilled++;
  }

  return {
    marketWasOpen: true,
    ordersEvaluated: candidates.length,
    ordersFilled,
    ordersExpired: 0,
  };
}

// Claims and, if its price condition is met, fills exactly one order - in
// its own short transaction, not the batch's transaction, so one order's
// failure or slowness can't hold a lock on (or roll back progress for)
// every other order in the same run, and so the account lock below is
// held for as little time as possible.
async function tryFillOneOrder(orderId: string, quote: Quote, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    // The same row lock cancelOrder (lib/db/orders.ts) takes - whichever
    // transaction, a user's cancellation or this worker's claim, acquires
    // it first wins the race. Re-checking status === "pending" after the
    // lock is what makes that race safe: a candidate list built from an
    // unlocked read (above) could include an order a concurrent
    // cancellation already claimed a moment earlier.
    const [order] = await tx
      .select({
        id: orders.id,
        accountId: orders.accountId,
        symbol: orders.symbol,
        side: orders.side,
        quantity: orders.quantity,
        limitPriceCents: orders.limitPriceCents,
        status: orders.status,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");

    if (!order || order.status !== "pending" || order.limitPriceCents === null) {
      return false;
    }

    if (
      !shouldFillLimitOrder({ side: order.side, limitPriceCents: order.limitPriceCents }, quote)
    ) {
      return false;
    }

    // Only locked now, after already knowing this order is worth filling -
    // the same lock primitive placeMarketOrder uses on the account row.
    const [lockedAccount] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, order.accountId))
      .for("update");

    if (!lockedAccount) {
      throw new Error(`Account ${order.accountId} not found`);
    }

    const accountState = await loadAccountState(tx, lockedAccount.id);
    // Re-validating funds/shares for real, not trusting the reservation
    // check made at placement time - the same execution path a market
    // order uses, so a limit order fills at the current quote (guaranteed
    // at least as good as its own limit price by shouldFillLimitOrder
    // above), not automatically at its limit price.
    const result = executeMarketOrder(accountState, quote, order.side, order.quantity, now);

    if (!result.ok) {
      // stale_quote is the one realistic, transient failure this
      // re-validation can produce: the quote batch was fetched once at the
      // top of this run, and a large batch may take long enough to work
      // through that a later order's quote has aged past the 60-second
      // window by the time its turn comes. Leaving it pending lets it try
      // again next run with a fresh quote. Anything else
      // (insufficient_funds/insufficient_shares) is exactly what
      // canPlaceLimitOrder's reservation accounting is supposed to make
      // structurally impossible - if it happens anyway, that's real
      // divergence between the reservation math and the account's actual
      // state, worth surfacing as a terminal rejection rather than
      // silently retrying forever against a condition that may never
      // resolve.
      if (result.reason !== "stale_quote") {
        await tx
          .update(orders)
          .set({ status: "rejected", rejectReason: result.reason })
          .where(eq(orders.id, order.id));
      }
      return false;
    }

    const { fill } = result;

    await tx
      .update(orders)
      .set({ status: "filled", filledPriceCents: fill.priceCents, filledAt: now })
      .where(eq(orders.id, order.id));

    await applyFillEffects(tx, lockedAccount.id, order.symbol, fill);
    await recordFillTransaction(tx, lockedAccount.id, order.id, order.side, fill);

    return true;
  });
}

export type LastLimitOrderWorkerRun = {
  startedAt: Date;
  finishedAt: Date | null;
  status: "running" | "succeeded" | "failed";
  marketWasOpen: boolean | null;
  ordersEvaluated: number | null;
  ordersFilled: number | null;
  ordersExpired: number | null;
  errorMessage: string | null;
};

// The most recent run this worker attempted, in ANY state - not just the
// last successful one (contrast lib/db/assets.ts's
// getLastSuccessfulAssetSync). A stuck "running" row (a crash mid-run) or
// a string of "failed" runs is exactly the abnormal condition
// app/api/worker/status/route.ts exists to surface, so filtering to
// "succeeded" here would hide the very thing observability is for.
export async function getLastLimitOrderWorkerRun(): Promise<LastLimitOrderWorkerRun | null> {
  const [latest] = await db
    .select()
    .from(limitOrderWorkerRuns)
    .orderBy(desc(limitOrderWorkerRuns.startedAt))
    .limit(1);

  return latest ?? null;
}
