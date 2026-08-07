import { describe, expect, it } from "vitest";
import {
  barChartTime,
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
