import type { Cents, Shares } from "./money";
import type { AccountState, RejectReason, Side } from "./types";

// The shape of an existing pending limit order this logic needs to know
// about - not the full DB row (no id, no timestamps, nothing lib/db/orders.ts
// wouldn't already have on hand from a plain query). Kept minimal
// deliberately: this file has no database access, per CLAUDE.md, so a
// caller in lib/db/ is responsible for turning real rows into this shape.
export type PendingLimitOrder = {
  side: Side;
  symbol: string;
  quantity: Shares;
  limitPriceCents: Cents;
};

// How much cash every OTHER pending buy limit order has already claimed -
// reserved at each order's own limit price, not the current market price.
// The limit price is the worst case that order could still cost (it will
// only ever fill at its limit price or better - see limit-fill.ts), and
// that worst case is the only number known for certain before it fills, so
// it's what has to be set aside to guarantee every pending buy could
// actually be paid for if all of them filled at once. Cash is one pool
// shared across every symbol, unlike shares below, so this sums across all
// pending buys regardless of symbol.
export function reservedCashCents(otherPendingBuyOrders: readonly PendingLimitOrder[]): Cents {
  return otherPendingBuyOrders.reduce(
    (sum, order) => sum + order.limitPriceCents * BigInt(order.quantity),
    0n,
  );
}

// How many shares of ONE symbol every other pending sell limit order for
// that same symbol has already claimed. Shares aren't fungible across
// symbols the way cash is - a pending sell of 10 AAPL shares says nothing
// about how many TSLA shares are available, so the caller must pre-filter
// to one symbol before calling this (see canPlaceLimitOrder below, which
// does this internally).
export function reservedShares(
  otherPendingSellOrdersForSymbol: readonly PendingLimitOrder[],
): Shares {
  return otherPendingSellOrdersForSymbol.reduce((sum, order) => sum + order.quantity, 0);
}

export type PlaceLimitOrderInput = {
  side: Side;
  symbol: string;
  quantity: Shares;
  limitPriceCents: Cents;
};

// Whether a new limit order can be accepted right now, given the account's
// real current cash/positions and every other order still resting on the
// book. Deliberately does NOT check market hours, a live quote, or quote
// staleness - a limit order is meant to sit and wait for its price
// condition, unlike a market order (see executeMarketOrder), so none of
// those apply at placement time. This only answers "is there room for this
// commitment", the same question executeMarketOrder's insufficient_funds/
// insufficient_shares checks answer for an order that executes immediately
// - reusing those same RejectReason values here (rather than inventing
// parallel ones) is deliberate: to the user, "not enough available cash"
// means the same thing whether the order fills now or waits.
export function canPlaceLimitOrder(
  account: AccountState,
  input: PlaceLimitOrderInput,
  otherPendingOrders: readonly PendingLimitOrder[],
): { ok: true } | { ok: false; reason: RejectReason } {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    return { ok: false, reason: "invalid_quantity" };
  }

  if (input.limitPriceCents <= 0n) {
    return { ok: false, reason: "invalid_limit_price" };
  }

  if (input.side === "buy") {
    const pendingBuys = otherPendingOrders.filter((order) => order.side === "buy");
    const availableCents = account.cashCents - reservedCashCents(pendingBuys);
    const costCents = input.limitPriceCents * BigInt(input.quantity);

    if (availableCents < costCents) {
      return { ok: false, reason: "insufficient_funds" };
    }

    return { ok: true };
  }

  const pendingSellsForSymbol = otherPendingOrders.filter(
    (order) => order.side === "sell" && order.symbol === input.symbol,
  );
  const heldQuantity = account.positions.get(input.symbol)?.quantity ?? 0;
  const availableShares = heldQuantity - reservedShares(pendingSellsForSymbol);

  if (availableShares < input.quantity) {
    return { ok: false, reason: "insufficient_shares" };
  }

  return { ok: true };
}
