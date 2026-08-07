import { describe, expect, it } from "vitest";
import {
  centsToDollars,
  formatDollars,
  isUpBar,
  timeToDateKey,
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

describe("timeToDateKey", () => {
  it("passes a string time through unchanged", () => {
    expect(timeToDateKey("2026-08-06")).toBe("2026-08-06");
  });

  it("reconstructs a date string from a BusinessDay object", () => {
    expect(timeToDateKey({ year: 2026, month: 8, day: 6 })).toBe("2026-08-06");
  });

  it("pads single-digit month and day in a BusinessDay object", () => {
    expect(timeToDateKey({ year: 2026, month: 1, day: 5 })).toBe("2026-01-05");
  });

  it("returns undefined for a UTCTimestamp number, which this chart never uses", () => {
    expect(timeToDateKey(1_700_000_000 as unknown as Parameters<typeof timeToDateKey>[0])).toBe(
      undefined,
    );
  });
});
