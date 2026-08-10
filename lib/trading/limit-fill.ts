import type { Cents } from "./money";
import type { Side } from "./types";

export type LimitOrderForFillCheck = {
  side: Side;
  limitPriceCents: Cents;
};

export type QuoteForFillCheck = {
  bidCents: Cents;
  askCents: Cents;
};

// The only question this answers: given the current quote, would this
// resting limit order transact right now? Nothing here decides the actual
// fill price (that's the current quote's own ask/bid, via the same
// executeMarketOrder path a market order uses - see lib/db/orders.ts) or
// re-checks funds/shares (also executeMarketOrder's job) - this is purely
// the price condition, kept small and separately testable from everything
// that has to happen once it's true.
//
// A buy limit fills when the market's ask has come down to (or below) what
// the order is willing to pay - buying at askCents, which by this
// condition is guaranteed <= limitPriceCents, is price improvement or an
// exact match, never worse than the limit. A sell limit fills when the
// market's bid has risen to (or above) what the order wants - selling at
// bidCents, guaranteed >= limitPriceCents by the same logic.
//
// Both comparisons are inclusive (<=/>=), not strict - a limit order at
// exactly the current ask/bid is exactly the price the user asked for, not
// merely close to it, and must fill.
export function shouldFillLimitOrder(
  order: LimitOrderForFillCheck,
  quote: QuoteForFillCheck,
): boolean {
  return order.side === "buy"
    ? quote.askCents <= order.limitPriceCents
    : quote.bidCents >= order.limitPriceCents;
}
