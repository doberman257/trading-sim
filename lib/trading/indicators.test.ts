import { describe, expect, it } from "vitest";
import { DEFAULT_RSI_PERIOD, ema, rollingHigh, rsi, sma } from "./indicators";
import { toCents } from "./money";

// Indicator outputs are in cents (fractional - see indicators.ts's own
// comment on why), same unit as the `cents()` helper below produces from
// dollar inputs - every expected value in this file is a cents figure too
// (e.g. $101.00 is 10100), not a dollar figure, to match.
function cents(dollars: number[]): bigint[] {
  return dollars.map((d) => toCents(d.toFixed(2)));
}

describe("sma", () => {
  it("returns null for every index when there are fewer bars than the period", () => {
    expect(sma(cents([100, 101]), 5)).toEqual([null, null]);
  });

  it("returns null for exactly the first period-1 indices, explicitly, not 0", () => {
    const result = sma(cents([100, 101, 102, 103, 104]), 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[0]).not.toBe(0);
  });

  it("is the constant value itself for a flat price series", () => {
    const result = sma(cents([100, 100, 100, 100]), 3);
    expect(result).toEqual([null, null, 10000, 10000]);
  });

  it("matches hand-computed values for a linear ramp", () => {
    // Prices $100, $101, $102, $103, $104 (10000, 10100, ... cents); period 3.
    // SMA[2] = avg(10000,10100,10200) = 10100, SMA[3] = avg(10100,10200,10300)
    // = 10200, SMA[4] = avg(10200,10300,10400) = 10300.
    const result = sma(cents([100, 101, 102, 103, 104]), 3);
    expect(result).toEqual([null, null, 10100, 10200, 10300]);
  });

  it("produces exactly one value when the input length equals the period", () => {
    const result = sma(cents([100, 200, 300]), 3);
    expect(result).toEqual([null, null, 20000]);
  });
});

describe("ema", () => {
  it("returns null for every index when there are fewer bars than the period", () => {
    expect(ema(cents([100, 101]), 5)).toEqual([null, null]);
  });

  it("seeds the first value as the SMA of the first `period` values, not the first value alone", () => {
    // If EMA were (wrongly) seeded from just values[period - 1], the first
    // value here would be 10200 ($102), not the SMA of the first 3, 10100 ($101).
    const result = ema(cents([100, 101, 102, 200, 200]), 3);
    expect(result[2]).toBeCloseTo(10100, 10);
  });

  it("is the constant value itself for a flat price series", () => {
    const result = ema(cents([100, 100, 100, 100]), 3);
    expect(result).toEqual([null, null, 10000, 10000]);
  });

  it("matches hand-computed values for a linear ramp", () => {
    // For a perfectly linear ramp, EMA seeded with SMA exactly tracks SMA
    // at every later point too - a real, checkable mathematical property
    // (not a coincidence specific to this data), which is exactly why a
    // linear ramp is "obvious by hand" for both functions.
    const smaResult = sma(cents([100, 101, 102, 103, 104, 105]), 3);
    const emaResult = ema(cents([100, 101, 102, 103, 104, 105]), 3);
    for (let i = 2; i < 6; i++) {
      expect(emaResult[i]).toBeCloseTo(smaResult[i]!, 10);
    }
  });

  it("reacts more to a recent price shock than SMA does, over the same period", () => {
    // Four flat periods at $100, then a jump to $200.
    const values = cents([100, 100, 100, 100, 200]);
    const smaResult = sma(values, 4);
    const emaResult = ema(values, 4);
    // SMA[4] = avg(10000,10000,10000,20000) = 12500 ($125).
    // EMA[4] = (20000-10000)*0.4+10000 = 14000 ($140).
    expect(smaResult[4]).toBeCloseTo(12500, 10);
    expect(emaResult[4]).toBeCloseTo(14000, 10);
    expect(emaResult[4]!).toBeGreaterThan(smaResult[4]!);
  });
});

describe("rsi", () => {
  it("defaults to a 14-period lookback", () => {
    const values = cents(Array.from({ length: 20 }, (_, i) => 100 + i));
    expect(rsi(values)).toEqual(rsi(values, DEFAULT_RSI_PERIOD));
    expect(DEFAULT_RSI_PERIOD).toBe(14);
  });

  it("returns null for every index when there are fewer than period + 1 bars", () => {
    const values = cents(Array.from({ length: 10 }, (_, i) => 100 + i));
    expect(rsi(values, 14).every((v) => v === null)).toBe(true);
  });

  it("returns null for exactly the first `period` indices, explicitly, not 0", () => {
    const values = cents(Array.from({ length: 16 }, (_, i) => 100 + i));
    const result = rsi(values, 14);
    expect(result.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(result[14]).not.toBeNull();
  });

  it("reaches exactly 100 for a strictly, uniformly increasing price series", () => {
    // Every delta is a gain, so average loss is 0 forever - RSI is exactly
    // 100, not just close to it, for the entire run once past the initial
    // lookback (this is the formula's real behavior, not an approximation).
    const values = cents(Array.from({ length: 20 }, (_, i) => 100 + i));
    const result = rsi(values, 14);
    for (let i = 14; i < values.length; i++) {
      expect(result[i]).toBe(100);
    }
  });

  it("reaches exactly 0 for a strictly, uniformly decreasing price series", () => {
    const values = cents(Array.from({ length: 20 }, (_, i) => 200 - i));
    const result = rsi(values, 14);
    for (let i = 14; i < values.length; i++) {
      expect(result[i]).toBe(0);
    }
  });

  it("is 50 for a perfectly flat price series - no momentum either way, not a divide-by-zero", () => {
    const values = cents(Array.from({ length: 20 }, () => 100));
    const result = rsi(values, 14);
    for (let i = 14; i < values.length; i++) {
      expect(result[i]).toBe(50);
    }
  });

  // Cross-checked against a published worked example (T3 Live's RSI
  // tutorial, https://www.t3live.com/rsi-swing-trading/), not just this
  // suite's own internal consistency. That example: 14 days of price
  // changes summing to $14 of gains and $4 of losses (average gain $1.00,
  // average loss $0.286, RSI 77.76), then a day-15 move of -$1 smoothed in
  // (new average gain $0.929, new average loss $0.337, RSI 73.38).
  //
  // The exact day-by-day path within the first 14 days isn't published,
  // only the totals - so this reconstructs a price series with the same
  // aggregate gain/loss totals (one +$14 move, twelve flat days, one -$4
  // move) rather than guessing at their unpublished exact path, then
  // applies the same published day-15 move (-$1) on top.
  it("matches a published worked example's RSI values, not just its own formula", () => {
    const values = cents([50, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 60, 59]);
    const result = rsi(values, 14);

    // The published RSI is 77.76, rounded from an average loss rounded to
    // 0.286 rather than the exact 2/7 - this implementation carries full
    // precision, so it lands at 77.78, a 0.02 difference explained
    // entirely by their intermediate rounding, not a formula mismatch.
    expect(result[14]).toBeCloseTo(77.78, 1);

    // Day 15 matches the published 73.38 almost exactly, since by this
    // point the rounding discrepancy from day 14 has barely compounded.
    expect(result[15]).toBeCloseTo(73.38, 1);
  });
});

describe("rollingHigh", () => {
  it("returns null for every index when there are fewer bars than the period", () => {
    expect(rollingHigh(cents([100, 101]), 5)).toEqual([null, null]);
  });

  it("returns null for exactly the first period-1 indices, explicitly, not 0", () => {
    const result = rollingHigh(cents([100, 101, 102, 103, 104]), 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[0]).not.toBe(0);
  });

  it("is the constant value itself for a flat price series", () => {
    const result = rollingHigh(cents([100, 100, 100, 100]), 3);
    expect(result).toEqual([null, null, 10000, 10000]);
  });

  it("matches hand-computed values for a rising-then-falling series, including at the current index", () => {
    // $100, $105, $110, $103, $98 (10000, 10500, 11000, 10300, 9800 cents); period 3.
    // Window ending at 2 (indices 0-2): max(10000,10500,11000) = 11000 -
    // the current index's own value can be the max, matching sma/ema's own
    // "trailing window including index i" convention.
    // Window ending at 3 (indices 1-3): max(10500,11000,10300) = 11000 -
    // still the now-past peak at index 2, correctly carried forward.
    // Window ending at 4 (indices 2-4): max(11000,10300,9800) = 11000 -
    // the peak is still inside this window (index 2), one index before it
    // would drop out.
    const result = rollingHigh(cents([100, 105, 110, 103, 98]), 3);
    expect(result).toEqual([null, null, 11000, 11000, 11000]);
  });

  it("drops the old high once it falls out of the trailing window", () => {
    // $110, $100, $100, $100, $100 (11000, 10000, ...); period 3. The $110
    // peak at index 0 is inside windows ending at 2 (indices 0-2), but
    // gone from the window ending at 3 (indices 1-3) - the rolling high
    // must fall back to $100 there, not keep reporting a high that's no
    // longer within the trailing period.
    const result = rollingHigh(cents([110, 100, 100, 100, 100]), 3);
    expect(result).toEqual([null, null, 11000, 10000, 10000]);
  });

  it("a real breakout: today's close exceeds the prior window's rolling high, read one index back", () => {
    // A flat run at $100, then a genuine breakout to $106 on the last day -
    // the exact comparison a breakout rule makes: today's raw close vs.
    // rollingHigh's value at the PRIOR index (the highest close before
    // today), not the value at today's own index (which would trivially
    // already include today's new high). Both indices compared here are
    // real, non-null values (period 3 needs index >= 2), not the null
    // lead-in already covered above.
    const closes = cents([100, 100, 100, 100, 106]);
    const result = rollingHigh(closes, 3);
    const todayIndex = 4;
    expect(Number(closes[todayIndex])).toBeGreaterThan(result[todayIndex - 1]!);
    // And the day before, $100 was not a breakout above its own prior
    // window's high ($100) - equal, not exceeding.
    const previousIndex = 3;
    expect(Number(closes[previousIndex])).not.toBeGreaterThan(result[previousIndex - 1]!);
  });
});
