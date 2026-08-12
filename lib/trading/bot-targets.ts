import type { Cents } from "./money";

// Profit target and stop-loss share this exact shape (user picks dollar or
// percent, per run - see the design brief) - one type, not two near-
// identical ones. `basisPoints` (not a plain fractional percent) matches
// the same integer-not-float convention this file's own
// isSpreadImplausiblyWide/WIDE_SPREAD_BASIS_POINTS already established for
// a rate that isn't itself money but still needs exact, non-drifting math.
export type TargetConfig =
  { type: "dollar"; valueCents: Cents } | { type: "percent"; basisPoints: number };

// The absolute cents value a target config resolves to, given the entry
// cost it's measured against - a percent target is meaningless on its own
// (5% of what?), so this always needs entryTotalCents, never capitalCents:
// entryTotalCents is what was actually spent once whole-share rounding is
// accounted for (see lib/trading/bot-sizing.ts), which is the true cost
// basis, not the nominal budget.
export function resolveTargetCents(config: TargetConfig, entryTotalCents: Cents): Cents {
  if (config.type === "dollar") {
    return config.valueCents;
  }
  return (entryTotalCents * BigInt(config.basisPoints)) / 10_000n;
}

// unrealizedPnlCents is signed (negative when underwater) - both checks
// compare it directly against the resolved target rather than against its
// absolute value, so a caller can never accidentally treat a loss as a
// profit-target hit or vice versa by passing the wrong sign.
export function isProfitTargetHit(
  unrealizedPnlCents: Cents,
  profitTarget: TargetConfig,
  entryTotalCents: Cents,
): boolean {
  return unrealizedPnlCents >= resolveTargetCents(profitTarget, entryTotalCents);
}

export function isStopLossHit(
  unrealizedPnlCents: Cents,
  stopLoss: TargetConfig,
  entryTotalCents: Cents,
): boolean {
  return unrealizedPnlCents <= -resolveTargetCents(stopLoss, entryTotalCents);
}

// The per-share price a resting profit-target limit sell must be placed at
// to GUARANTEE at least the target profit if it fills - see
// lib/trading/limit-fill.ts's own note that a limit sell can only fill at
// its own price or better (bid >= limitPriceCents), never worse. Rounds up
// (ceiling division), never down: rounding down could shave a fraction of a
// cent per share off the guarantee, which is the wrong direction for an
// order whose whole point is a firm bound - the same "Max cost (limit)"/
// "Min proceeds (limit)" framing OrderTicket already uses for a
// human-placed limit order.
export function computeProfitTargetLimitPriceCents(
  entryTotalCents: Cents,
  quantity: number,
  profitTarget: TargetConfig,
): Cents {
  const targetCents = resolveTargetCents(profitTarget, entryTotalCents);
  const rawTotalCents = entryTotalCents + targetCents;
  const quantityBig = BigInt(quantity);
  return (rawTotalCents + quantityBig - 1n) / quantityBig;
}

export type TargetValidationError =
  "invalid_dollar_amount" | "invalid_percent" | "dollar_amount_exceeds_capital";

// Validated at config time (before a bot run is ever created), the same
// "reject nonsense up front" discipline canPlaceLimitOrder already applies
// to a limit price - a required field a user can still set to something
// meaningless (a stop-loss of $0, or 150%) isn't materially better than an
// optional one. capitalCents is the right thing to validate a dollar amount
// against here, not entryTotalCents: this runs before a symbol is even
// selected, so entryTotalCents doesn't exist yet.
export function validateTargetConfig(
  config: TargetConfig,
  capitalCents: Cents,
): TargetValidationError | null {
  if (config.type === "dollar") {
    if (config.valueCents <= 0n) return "invalid_dollar_amount";
    if (config.valueCents > capitalCents) return "dollar_amount_exceeds_capital";
    return null;
  }

  if (config.basisPoints <= 0 || config.basisPoints >= 10_000) return "invalid_percent";
  return null;
}
