import { describe, expect, it } from "vitest";
import { sma } from "@/lib/trading/indicators";
import { toCents } from "@/lib/trading/money";
import {
  barChartTime,
  buildLineSeriesData,
  centsToDollars,
  findBarIndexAtOrBefore,
  formatDollars,
  isUpBar,
  normalizeChartTime,
  withAlpha,
} from "./stockChartFormat";

describe("centsToDollars", () => {
  it("converts whole dollars", () => {
    expect(centsToDollars("10000")).toBe(100);
  });

  it("converts fractional cents", () => {
    expect(centsToDollars("31456")).toBe(314.56);
  });

  it("handles zero", () => {
    expect(centsToDollars("0")).toBe(0);
  });
});

describe("formatDollars", () => {
  it("always shows two decimals", () => {
    expect(formatDollars("10000")).toBe("100.00");
  });

  it("does not round away real cents", () => {
    expect(formatDollars("31456")).toBe("314.56");
  });
});

describe("withAlpha", () => {
  it("appends the alpha channel to a hex color", () => {
    expect(withAlpha("#22c55e", "80")).toBe("#22c55e80");
  });
});

describe("isUpBar", () => {
  it("is true when close is above open", () => {
    expect(isUpBar("9999", "10050")).toBe(true);
  });

  it("is true when close equals open", () => {
    expect(isUpBar("10000", "10000")).toBe(true);
  });

  it("is false when close is below open", () => {
    expect(isUpBar("10050", "9999")).toBe(false);
  });

  it("compares numerically, not lexicographically, across a digit-count boundary", () => {
    // "9999" >= "10050" is true as a plain string comparison (lexicographic:
    // '9' > '1') even though 9999 < 10050 numerically - this is the exact
    // bug isUpBar exists to avoid.
    expect("9999" >= "10050").toBe(true);
    expect(isUpBar("10050", "9999")).toBe(false);
  });
});

describe("barChartTime", () => {
  it("slices a daily bar's timestamp to a business-day date string", () => {
    expect(barChartTime("2026-08-06T04:00:00Z", "1Day")).toBe("2026-08-06");
  });

  it("slices a weekly bar's timestamp to a business-day date string", () => {
    expect(barChartTime("2026-04-13T04:00:00Z", "1Week")).toBe("2026-04-13");
  });

  it("converts a 15-minute bar's timestamp to a numeric UTCTimestamp", () => {
    expect(barChartTime("2026-08-06T14:30:00Z", "15Min")).toBe(
      Math.floor(new Date("2026-08-06T14:30:00Z").getTime() / 1000),
    );
  });

  it("converts an hourly bar's timestamp to a numeric UTCTimestamp", () => {
    expect(barChartTime("2026-08-06T14:00:00Z", "1Hour")).toBe(
      Math.floor(new Date("2026-08-06T14:00:00Z").getTime() / 1000),
    );
  });
});

describe("normalizeChartTime", () => {
  it("passes a string time through unchanged", () => {
    expect(normalizeChartTime("2026-08-06")).toBe("2026-08-06");
  });

  it("passes a numeric UTCTimestamp through unchanged", () => {
    expect(
      normalizeChartTime(1_700_000_000 as unknown as Parameters<typeof normalizeChartTime>[0]),
    ).toBe(1_700_000_000);
  });

  it("reconstructs a date string from a BusinessDay object", () => {
    expect(normalizeChartTime({ year: 2026, month: 8, day: 6 })).toBe("2026-08-06");
  });

  it("pads single-digit month and day in a BusinessDay object", () => {
    expect(normalizeChartTime({ year: 2026, month: 1, day: 5 })).toBe("2026-01-05");
  });
});

describe("findBarIndexAtOrBefore", () => {
  const timestamps = ["2026-08-06T14:00:00Z", "2026-08-06T14:15:00Z", "2026-08-06T14:30:00Z"];

  it("finds the exact matching bar", () => {
    expect(findBarIndexAtOrBefore(timestamps, "2026-08-06T14:15:00Z")).toBe(1);
  });

  it("finds the last bar at or before an instant that falls between bars", () => {
    expect(findBarIndexAtOrBefore(timestamps, "2026-08-06T14:20:00Z")).toBe(1);
  });

  it("finds the last bar when the instant is after every bar", () => {
    expect(findBarIndexAtOrBefore(timestamps, "2026-08-06T15:00:00Z")).toBe(2);
  });

  it("returns -1 when the instant is before every bar", () => {
    expect(findBarIndexAtOrBefore(timestamps, "2026-08-06T13:00:00Z")).toBe(-1);
  });

  it("returns -1 for an empty bar list", () => {
    expect(findBarIndexAtOrBefore([], "2026-08-06T14:15:00Z")).toBe(-1);
  });
});

describe("buildLineSeriesData", () => {
  it("omits points with no value entirely, not as a plotted zero", () => {
    const bars = [
      { timestamp: "2026-08-01T04:00:00Z" },
      { timestamp: "2026-08-02T04:00:00Z" },
      { timestamp: "2026-08-03T04:00:00Z" },
    ];
    const values = [null, 100, null];

    const points = buildLineSeriesData(bars, values, "1Day");

    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({ time: "2026-08-02", value: 100 });
  });

  it("maps each bar's own timeframe-appropriate time alongside its value", () => {
    const bars = [{ timestamp: "2026-08-06T14:00:00Z" }, { timestamp: "2026-08-06T14:15:00Z" }];
    const values = [10, 20];

    expect(buildLineSeriesData(bars, values, "15Min")).toEqual([
      { time: Math.floor(new Date("2026-08-06T14:00:00Z").getTime() / 1000), value: 10 },
      { time: Math.floor(new Date("2026-08-06T14:15:00Z").getTime() / 1000), value: 20 },
    ]);
  });

  it("returns an empty array when every value is null", () => {
    const bars = [{ timestamp: "2026-08-01T04:00:00Z" }, { timestamp: "2026-08-02T04:00:00Z" }];
    expect(buildLineSeriesData(bars, [null, null], "1Day")).toEqual([]);
  });

  // The exact real scenario a user hit: a 1M range at a 1D interval loads
  // roughly 22 daily bars, and SMA(20) needs 20 bars for its first value -
  // this is what actually reaches the chart for that case, not just what
  // lib/trading/indicators.ts's own tests say sma() returns in isolation.
  // Closes the specific gap unit tests on the pure function alone can't
  // catch: the indicator math being correct while the chart-integration
  // step that feeds it to lightweight-charts silently drops or corrupts it.
  it("produces only the few valid trailing points for SMA(20) over ~22 bars, not zero and not all of them", () => {
    const barCount = 22;
    const period = 20;
    const bars = Array.from({ length: barCount }, (_, i) => ({
      timestamp: new Date(Date.UTC(2026, 5, 1 + i, 4)).toISOString(),
    }));
    const closes = Array.from({ length: barCount }, (_, i) => toCents((100 + i).toFixed(2)));

    const smaValues = sma(closes, period);
    const points = buildLineSeriesData(bars, smaValues, "1Day");

    // barCount - period + 1 valid points: bars 0..18 (index 0-18) have no
    // value yet, 19-21 do.
    expect(points).toHaveLength(3);
    expect(points.map((p) => p.time)).toEqual(["2026-06-20", "2026-06-21", "2026-06-22"]);
  });
});
