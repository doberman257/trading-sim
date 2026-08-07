import type { Cents } from "./money";

export type AllocationSlice = {
  /** A symbol, or "Cash" when kind is "cash". */
  label: string;
  // A discriminator, not left for callers to infer from `label === "Cash"` -
  // string-matching a display label to recover meaning is exactly the kind
  // of thing that breaks quietly if the label wording ever changes.
  kind: "position" | "cash";
  valueCents: Cents;
  /** 0-100. Always 0 when totalEquityCents is 0, never NaN/Infinity. */
  percent: number;
};

// Cash is always its own slice, appended after every position - positions
// sort largest-to-smallest by market value, but cash's placement is
// consistent regardless of its size, since it isn't "an investment" in the
// same sense a held symbol is and shouldn't jump around in the ordering.
//
// A position with no live quote (marketValueCents: null, per
// calculatePortfolio in lib/trading/portfolio.ts) is excluded entirely
// rather than shown as zero - the caller's totalEquityCents already
// excludes that position's unknown contribution for the same reason, so
// omitting it here keeps the returned percentages consistent with what
// totalEquityCents actually represents instead of silently summing to less
// than 100%.
export function calculateAllocation(
  positions: readonly { symbol: string; marketValueCents: Cents | null }[],
  cashCents: Cents,
  totalEquityCents: Cents,
): AllocationSlice[] {
  function percentOf(valueCents: Cents): number {
    return totalEquityCents === 0n ? 0 : (Number(valueCents) / Number(totalEquityCents)) * 100;
  }

  const positionSlices: AllocationSlice[] = positions
    .filter((position) => position.marketValueCents !== null)
    .map((position) => ({
      label: position.symbol,
      kind: "position" as const,
      // Non-null by construction: filtered just above. TypeScript can't
      // narrow through the boolean filter's closure, so this is asserted,
      // not re-checked.
      valueCents: position.marketValueCents!,
      percent: percentOf(position.marketValueCents!),
    }))
    // Compared as BigInt, not converted to Number first: a difference this
    // large would still sort correctly as a Number in practice at this
    // app's balances, but there's no reason to risk it when a direct
    // comparison is just as simple.
    .sort((a, b) => {
      if (a.valueCents < b.valueCents) return 1;
      if (a.valueCents > b.valueCents) return -1;
      return 0;
    });

  const cashSlice: AllocationSlice = {
    label: "Cash",
    kind: "cash",
    valueCents: cashCents,
    percent: percentOf(cashCents),
  };

  return [...positionSlices, cashSlice];
}
