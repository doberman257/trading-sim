import type { Cents, Shares } from "./money";

export type Side = "buy" | "sell";

export type Quote = {
  symbol: string;
  bidCents: Cents;
  askCents: Cents;
  timestamp: Date;
};

export type Position = {
  quantity: Shares;
  avgCostCents: Cents;
};

export type AccountState = {
  cashCents: Cents;
  positions: ReadonlyMap<string, Position>;
};

export type Fill = {
  side: Side;
  symbol: string;
  quantity: Shares;
  priceCents: Cents;
  totalCents: Cents;
  newCashCents: Cents;
  newPosition: Position | null;
  realizedPnlCents: Cents | null;
};

export type RejectReason =
  | "insufficient_funds"
  | "insufficient_shares"
  | "invalid_quantity"
  | "market_closed"
  | "stale_quote"
  // Alpaca returned a quote with a zero-priced bid or ask - no active
  // two-sided market right now (most often seen while the market is
  // closed), not a real price. See NoTwoSidedQuoteError in
  // lib/market/alpaca.ts, which is what placeMarketOrder catches to
  // produce this reason instead of letting the error propagate.
  | "no_quote"
  // A limit order's own limitPriceCents was zero or negative - see
  // canPlaceLimitOrder in lib/trading/limit-reservation.ts. Distinct from
  // invalid_quantity (which is about the share count, not the price).
  | "invalid_limit_price";

export type OrderResult = { ok: true; fill: Fill } | { ok: false; reason: RejectReason };

// A limit order's placement outcome is not an OrderResult: nothing fills at
// placement time (that's the worker's job, later - see
// lib/db/limit-order-worker.ts), so there's no Fill to return on success,
// only the id of the resting order that was accepted. The rejection side
// still reuses RejectReason, per canPlaceLimitOrder in
// lib/trading/limit-reservation.ts - "not enough available cash" means the
// same thing to a user whether the order was going to fill immediately or
// wait.
export type PlaceLimitOrderResult =
  { ok: true; orderId: string } | { ok: false; reason: RejectReason };

export type CancelOrderReason =
  // No pending order with this id exists for this account - either it was
  // never this account's order, or the id is simply wrong. Deliberately
  // the same reason for "doesn't exist" and "belongs to someone else" -
  // confirming an order id exists for an account that isn't yours is its
  // own small information leak.
  | "not_found"
  // The worker's fill check and this cancellation raced, and the worker
  // won - the row was already "filled" by the time this cancellation
  // acquired the lock. A real, expected outcome under concurrent access,
  // not an error: the same discriminated-union discipline as OrderResult
  // applies here too, per CLAUDE.md.
  | "already_filled"
  // The order exists but is no longer "pending" for some other reason
  // (already cancelled, rejected at placement, or expired at market
  // close) - there's nothing left to cancel.
  | "not_cancellable";

export type CancelOrderResult = { ok: true } | { ok: false; reason: CancelOrderReason };
