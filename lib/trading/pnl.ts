import { multiply, type Cents, type Shares } from "./money";

export type PositionValuation = {
  marketValueCents: Cents;
  unrealizedPnlCents: Cents;
  /** Percentage change from avgCostCents to currentPriceCents. 0 when avgCostCents is 0. */
  unrealizedPnlPercent: number;
};

// Mark-to-market valuation of an open position. Unlike realized P&L (which
// is only computed on sell, in execute.ts), this doesn't touch the account
// or the ledger - it's a pure read of "what would this position be worth
// right now," used for display only.
export function valuePosition(
  avgCostCents: Cents,
  currentPriceCents: Cents,
  quantity: Shares,
): PositionValuation {
  const marketValueCents = multiply(currentPriceCents, quantity);
  const deltaCents = currentPriceCents - avgCostCents;
  const unrealizedPnlCents = multiply(deltaCents, quantity);
  const unrealizedPnlPercent =
    avgCostCents === 0n ? 0 : (Number(deltaCents) / Number(avgCostCents)) * 100;

  return { marketValueCents, unrealizedPnlCents, unrealizedPnlPercent };
}
