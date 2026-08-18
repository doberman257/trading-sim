import type { Cents } from "./money";

// Pure functions over an array of closing prices - no chart library
// imports, no fetching, no React, per CLAUDE.md. Inputs are Cents (this
// app's money type throughout), but outputs are plain `number`, still
// denominated in cents but fractional (an average of integer cents rarely
// divides evenly) - the same choice lib/trading/pnl.ts already made for
// unrealizedPnlPercent: a derived statistic, not money being moved or
// stored, so it doesn't need bigint's exactness. Display code converts to
// dollars at the boundary, the same place it already converts a bar's
// own OHLC values (see components/stockChartFormat.ts's centsToDollars).
//
// Every function returns an array the same length as its input. Indices
// without enough preceding data to compute a real value are `null`, never
// 0 - a moving average of 0 would be indistinguishable from a real
// computed value that happened to be zero, which is exactly the kind of
// silent wrong-answer this project's "null means unknown" convention
// (see calculatePortfolio) exists to avoid.

// Simple moving average: the unweighted mean of the trailing `period`
// values, computed via a sliding sum so this stays O(n) rather than
// re-summing the whole window at every index.
export function sma(values: readonly Cents[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  let windowSum = 0;

  for (let i = 0; i < values.length; i++) {
    windowSum += Number(values[i]);
    if (i >= period) {
      windowSum -= Number(values[i - period]);
    }
    if (i >= period - 1) {
      result[i] = windowSum / period;
    }
  }

  return result;
}

// Exponential moving average. The first real value (at index `period - 1`)
// is conventionally the SMA of the first `period` values, not the first
// value alone or an EMA-of-nothing - seeding it any other way produces a
// result that still looks like a plausible line on a chart while being
// subtly wrong for every point after it, since each later value is
// computed from the one before.
export function ema(values: readonly Cents[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) {
    return result;
  }

  const multiplier = 2 / (period + 1);

  let seedSum = 0;
  for (let i = 0; i < period; i++) {
    seedSum += Number(values[i]);
  }
  let previous = seedSum / period;
  result[period - 1] = previous;

  for (let i = period; i < values.length; i++) {
    const current = (Number(values[i]) - previous) * multiplier + previous;
    result[i] = current;
    previous = current;
  }

  return result;
}

export const DEFAULT_RSI_PERIOD = 14;

// Relative strength index, Wilder's original smoothing (not a plain moving
// average of gains/losses): after the first `period`-length simple average
// seeds it, each later average gain/loss carries forward
// `(previous * (period - 1) + current) / period` rather than only looking
// at the trailing window - this is what "RSI" conventionally means, and a
// plain-moving-average version would produce visibly different numbers
// from every real charting platform's RSI on the same data.
//
// Needs `period + 1` prices for its first value (period price-to-price
// changes), one more than sma/ema need for their first value.
export function rsi(
  values: readonly Cents[],
  period: number = DEFAULT_RSI_PERIOD,
): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period + 1) {
    return result;
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const delta = Number(values[i]) - Number(values[i - 1]);
    if (delta > 0) gainSum += delta;
    else lossSum += -delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  result[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const delta = Number(values[i]) - Number(values[i - 1]);
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = rsiFromAverages(avgGain, avgLoss);
  }

  return result;
}

// Highest close in the trailing `period` values, index `i` included -
// matches sma/ema/rsi's own trailing-window convention exactly (a "20-day
// high" at index i means the max of indices [i-19, i], not [i-20, i-1]).
// A breakout rule comparing "is today's close a new high" reads this
// result at index i-1 (yesterday's trailing high, excluding today) against
// today's own close - the same shape as a golden-cross rule comparing two
// moving averages at consecutive indices. Deciding what counts as "a new
// high" is the rule's job, not this function's - same separation sma/ema
// already keep from ruleShouldEnter's own comparisons.
//
// O(n * period), not the O(n) a monotonic-deque rolling-max would give -
// deliberately not worth the extra complexity at this app's real scale
// (period is a small fixed window like 20, n is at most a few thousand
// bars), the same tradeoff call this file already makes elsewhere (sma
// itself is O(n) via a sliding sum only because a sum, unlike a max, is
// cheap to update incrementally without extra bookkeeping).
export function rollingHigh(values: readonly Cents[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    let max = -Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const value = Number(values[j]);
      if (value > max) max = value;
    }
    result[i] = max;
  }

  return result;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  // A perfectly flat run (every delta exactly zero) has no gains and no
  // losses to compare - conventionally read as "no momentum either way,"
  // not as a divide-by-zero. Losing money at every step (avgGain 0, avgLoss
  // nonzero) is the genuine 0 case, and the reverse is the genuine 100 case;
  // neither is an edge case needing special-casing beyond avoiding 0/0.
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
