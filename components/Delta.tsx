import { formatCents } from "@/lib/trading/money";

export type DeltaProps = {
  cents: bigint;
  percent?: number;
  // No default on purpose: per the trading-ui-design skill, a money value
  // gets a "$" when standalone (no column header carries the currency) and
  // never when it's a table cell under a header that already says "($)".
  // Forcing every call site to choose is what catches the zero-vs-nonzero
  // inconsistency this prop was added to fix, instead of silently defaulting
  // one way and reproducing it somewhere else later.
  showCurrency: boolean;
};

// Exported so the exact text is unit-testable without a DOM/render setup,
// same reasoning as MarketStatusBanner's openMessage/closedMessage. This is
// the piece that had the bug: the "$" lived nowhere in the old
// implementation, for any sign, not just zero - it only showed up as a
// visible bug on zero because that's the only value a brand-new account
// with no positions can produce.
export function formatDeltaAmount(cents: bigint, showCurrency: boolean): string {
  const flat = cents === 0n;
  const up = cents >= 0n;
  const absCents = cents < 0n ? -cents : cents;
  const sign = flat ? "" : up ? "+" : "−";

  return `${sign}${showCurrency ? "$" : ""}${formatCents(absCents)}`;
}

// A genuinely nonzero percent can still round to "0.0" at one decimal place
// (e.g. -0.049%) - displayed with a sign, that reads as "-0.0%", which looks
// like a bug (negative zero) rather than "a real but tiny loss". Only exact
// zero (no change at all) gets "0.0%", unsigned. Anything nonzero that would
// otherwise round to zero gets "<0.1%" instead - magnitude-only, no sign,
// since the direction glyph and the cents amount right next to it already
// say which way it moved; a sign on "<0.1%" would just be visual noise
// ("-<0.1%" answers a question nobody asked more precisely than intended).
export function formatDeltaPercent(percent: number): string {
  if (percent === 0) {
    return "0.0%";
  }

  const roundedAbs = Math.abs(percent).toFixed(1);
  if (roundedAbs === "0.0") {
    return "<0.1%";
  }

  return `${percent > 0 ? "+" : "−"}${roundedAbs}%`;
}

// The canonical gain/loss display from the trading-ui-design skill: sign,
// direction glyph, and color together - never color alone.
export function Delta({ cents, percent, showCurrency }: DeltaProps) {
  const up = cents >= 0n;
  const flat = cents === 0n;

  return (
    <span
      className={`font-mono tabular-nums ${flat ? "text-muted" : up ? "text-gain" : "text-loss"}`}
      aria-label={`${flat ? "flat" : up ? "up" : "down"} ${formatCents(cents < 0n ? -cents : cents)}${
        percent !== undefined ? `, ${formatDeltaPercent(percent).replace("%", " percent")}` : ""
      }`}
    >
      {!flat && <span aria-hidden>{up ? "▲" : "▼"}</span>} {formatDeltaAmount(cents, showCurrency)}
      {percent !== undefined && <> ({formatDeltaPercent(percent)})</>}
    </span>
  );
}
