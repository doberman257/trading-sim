import type { Cents, Shares } from "./money";

export type BotSizingResult = {
  quantity: Shares;
  // quantity * askCents - can be less than the capital budget once
  // whole-share rounding leaves a remainder (e.g. a $1,000 budget against a
  // $310 stock buys 3 shares, $930 spent, $70 unspent). This, not the
  // budget itself, is what a bot run's profit target/stop-loss and eventual
  // realized P&L are measured against - see lib/db/schema.ts's
  // bot_runs.entryTotalCents.
  entryTotalCents: Cents;
};

// Capital is fixed, quantity is derived - never the other way around. No
// fractional shares (this app has none anywhere - executeMarketOrder
// enforces the same integer-quantity rule), so `null` is a real, expected
// outcome when the budget can't afford even one share at the current ask,
// not an error: the caller (lib/db/bot-runs.ts) is expected to fall back to
// the next-ranked candidate, or fail the run entirely if none are
// affordable - see rankEligibleBotCandidates in lib/trading/bot-selection.ts.
export function computeBotOrderQuantity(
  capitalCents: Cents,
  askCents: Cents,
): BotSizingResult | null {
  if (askCents <= 0n) {
    return null;
  }

  const quantity = capitalCents / askCents; // bigint division floors toward zero
  if (quantity <= 0n) {
    return null;
  }

  return {
    quantity: Number(quantity),
    entryTotalCents: quantity * askCents,
  };
}
