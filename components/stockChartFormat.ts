import { isBusinessDay, type Time, type UTCTimestamp } from "lightweight-charts";
import type { BarTimeframe } from "@/lib/market/alpaca";

// Kept in its own file, separate from StockChart.tsx: that component calls
// createChart, which touches the DOM - pulling it into the default unit
// suite (which runs under Vitest's "node" environment, no DOM) would risk
// breaking on import alone. This file only imports small type-guards/types,
// so the actual logic here stays testable without a browser, same reasoning
// as orderMessages.ts staying DB-free. The BarTimeframe import is type-only
// and erased at compile time, so it doesn't pull in alpaca.ts's server-only
// guard or network code either.

export function centsToDollars(cents: string): number {
  return Number(BigInt(cents)) / 100;
}

export function formatDollars(cents: string): string {
  return centsToDollars(cents).toFixed(2);
}

// Appends an alpha channel to a 6-digit hex color - a canvas library needing
// a literal color string is a legitimate exception to "semantic tokens
// only," but that exception doesn't extend to inventing a new shade; this
// only ever dims a token already read from globals.css.
export function withAlpha(hex: string, alphaHex: string): string {
  return `${hex}${alphaHex}`;
}

// Converts a bar's full ISO timestamp into the Time representation
// lightweight-charts expects for its own granularity.
//
// 1Day/1Week bars use a "YYYY-MM-DD" business-day string, not a numeric
// timestamp: Alpaca's own daily/weekly bar timestamps are already midnight
// Eastern (confirmed empirically to be DST-correct), and the business-day
// string form is what makes the chart's time axis skip weekends/holidays
// as adjacent bars instead of showing them as a wide empty gap.
//
// 15Min/1Hour bars use a numeric UTCTimestamp instead, since multiple bars
// share the same calendar day - a bare date string can't tell them apart.
export function barChartTime(timestamp: string, timeframe: BarTimeframe): Time {
  if (timeframe === "1Day" || timeframe === "1Week") {
    return timestamp.slice(0, 10);
  }
  return Math.floor(new Date(timestamp).getTime() / 1000) as UTCTimestamp;
}

// The library accepts the Time values barChartTime produces above, but
// there's no guarantee it hands back the exact same shape from a
// crosshair-move event - a business-day string may come back as a
// BusinessDay object instead. Using isBusinessDay (exported by the library
// itself, not a hand-rolled guess at its internal representation) to
// reconstruct the same "YYYY-MM-DD" form either way is what makes a
// crosshair-driven lookup reliable. A UTCTimestamp number passes through
// unchanged - the library has no alternate representation for that case.
export function normalizeChartTime(time: Time): string | number | undefined {
  if (typeof time === "number") return time;
  if (typeof time === "string") return time;
  if (isBusinessDay(time)) {
    return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
  }
  return undefined;
}

// The index of the last bar whose own timestamp is at or before `instant` -
// i.e. the bar a trade fill at that instant belongs to, for placing a
// marker. `barTimestamps` must be ascending (the order every bars-fetching
// function in lib/market/alpaca.ts already returns), which is what lets
// this stop scanning as soon as one bar is later than `instant` rather than
// checking the rest. Returns -1 when every bar is later than `instant` (the
// trade predates this chart's loaded range - nothing to anchor a marker
// to).
export function findBarIndexAtOrBefore(barTimestamps: readonly string[], instant: string): number {
  const instantMs = new Date(instant).getTime();
  let lastIndexAtOrBefore = -1;

  for (let i = 0; i < barTimestamps.length; i++) {
    if (new Date(barTimestamps[i]!).getTime() > instantMs) {
      break;
    }
    lastIndexAtOrBefore = i;
  }

  return lastIndexAtOrBefore;
}

// Turns a parallel array of indicator values (one per bar, `null` wherever
// there isn't enough preceding data - see lib/trading/indicators.ts) into
// the line-series points lightweight-charts actually gets fed. This is the
// one piece of the chart integration that's genuinely worth its own unit
// test: the indicator math itself is already tested in isolation, and the
// chart-rendering side can't be (no DOM in this project's test
// environment), so this is the one place a "computed correctly but never
// actually reaches the chart" gap could hide undetected - e.g. a
// too-short valid run (a real case: SMA(20) over a ~22-bar 1M/1D window
// has only a few non-null points) silently producing an empty series
// instead of the few real points, or `null` slipping through as a plotted
// zero.
export function buildLineSeriesData(
  bars: readonly { timestamp: string }[],
  values: readonly (number | null)[],
  timeframe: BarTimeframe,
): { time: Time; value: number }[] {
  const points: { time: Time; value: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    const value = values[i];
    if (value !== null && value !== undefined) {
      points.push({ time: barChartTime(bars[i]!.timestamp, timeframe), value });
    }
  }
  return points;
}

// True when a bar's own close is at or above its own open - used to color
// both the candle and its volume bar the same direction. Compared as
// BigInt, not string >=: "10050" >= "9999" is false lexicographically (a
// real bug caught during development) even though 10050 is numerically
// larger - exactly the trap string-compared cents values fall into whenever
// open and close land on different digit counts.
export function isUpBar(openCents: string, closeCents: string): boolean {
  return BigInt(closeCents) >= BigInt(openCents);
}
