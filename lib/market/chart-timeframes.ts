import type { BarTimeframe } from "./alpaca";

export type ChartRange = "1W" | "1M" | "3M" | "1Y";

export const CHART_RANGES: readonly ChartRange[] = ["1W", "1M", "3M", "1Y"];

const DAY_MS = 24 * 60 * 60 * 1000;

export const RANGE_LOOKBACK_MS: Record<ChartRange, number> = {
  "1W": 7 * DAY_MS,
  "1M": 30 * DAY_MS,
  "3M": 90 * DAY_MS,
  "1Y": 365 * DAY_MS,
};

export const TIMEFRAME_ORDER: readonly BarTimeframe[] = ["15Min", "1Hour", "1Day", "1Week"];

// Which timeframes are meaningful at each range, not just technically
// fetchable. A finer timeframe over a longer range produces a genuinely
// unhelpful chart, not just a slow one - a year of 15-minute bars is
// several thousand candles with no visible structure. Ranges get coarser
// as they get longer: the finest timeframe an entry allows is what's kept.
//
//   1W:  15Min, 1Hour, 1Day
//   1M:  15Min, 1Hour, 1Day, 1Week
//   3M:        1Hour, 1Day, 1Week
//   1Y:               1Day, 1Week
//
// A combination that's merely sparse but still shows real structure (e.g.
// 1Day bars over a 1W range, ~7 bars) is left allowed - too few bars is a
// visibly honest "not much to show," never wrong the way too many bars is
// (a screen you can't read at all). A combination with essentially nothing
// to show (e.g. 1Week bars over a 1W range, ~1 bar) is still excluded below.
const ALLOWED_TIMEFRAMES_BY_RANGE: Record<ChartRange, readonly BarTimeframe[]> = {
  "1W": ["15Min", "1Hour", "1Day"],
  "1M": ["15Min", "1Hour", "1Day", "1Week"],
  "3M": ["1Hour", "1Day", "1Week"],
  "1Y": ["1Day", "1Week"],
};

export function allowedTimeframesForRange(range: ChartRange): readonly BarTimeframe[] {
  return ALLOWED_TIMEFRAMES_BY_RANGE[range];
}

export function isValidTimeframeForRange(range: ChartRange, timeframe: BarTimeframe): boolean {
  return ALLOWED_TIMEFRAMES_BY_RANGE[range].includes(timeframe);
}

// Why a disabled timeframe is disabled, for messaging. Every range's allowed
// set is a contiguous slice of TIMEFRAME_ORDER (finer-to-coarser), so an
// invalid timeframe is either finer than everything allowed (too many bars
// to render meaningfully) or coarser than everything allowed (too few bars
// to show anything useful) - never both, and never neither.
export function timeframeIncompatibilityReason(
  range: ChartRange,
  timeframe: BarTimeframe,
): "too-many-bars" | "too-few-bars" | null {
  if (isValidTimeframeForRange(range, timeframe)) {
    return null;
  }

  const timeframeIndex = TIMEFRAME_ORDER.indexOf(timeframe);
  const finestAllowedIndex = Math.min(
    ...allowedTimeframesForRange(range).map((tf) => TIMEFRAME_ORDER.indexOf(tf)),
  );

  return timeframeIndex < finestAllowedIndex ? "too-many-bars" : "too-few-bars";
}

// When switching to a range that makes the currently-selected timeframe
// invalid, this picks the replacement - deterministically, so switching
// ranges never leaves the UI in a state with no valid timeframe selected
// (which "just disable the invalid button" alone would, whenever the
// previously-selected one was the one that became invalid).
//
// Walks TIMEFRAME_ORDER from the current timeframe's position outward
// (coarser first, since going from an invalidated fine timeframe to the
// next-coarser one changes the least about what the user was looking at;
// finer is tried only if nothing coarser qualifies) and returns the first
// timeframe the new range allows.
export function nearestValidTimeframe(
  range: ChartRange,
  currentTimeframe: BarTimeframe,
): BarTimeframe {
  if (isValidTimeframeForRange(range, currentTimeframe)) {
    return currentTimeframe;
  }

  const currentIndex = TIMEFRAME_ORDER.indexOf(currentTimeframe);
  const coarser = TIMEFRAME_ORDER.slice(currentIndex + 1);
  const finer = TIMEFRAME_ORDER.slice(0, currentIndex).reverse();

  for (const candidate of [...coarser, ...finer]) {
    if (isValidTimeframeForRange(range, candidate)) {
      return candidate;
    }
  }

  // Unreachable in practice - every range in ALLOWED_TIMEFRAMES_BY_RANGE
  // allows at least one timeframe - but a total fallback keeps this
  // function's return type honest rather than possibly undefined.
  return allowedTimeframesForRange(range)[0]!;
}
