import { describe, expect, it } from "vitest";
import { toCents } from "@/lib/trading/money";
import { formatDeltaAmount, formatDeltaPercent } from "./Delta";

describe("formatDeltaAmount", () => {
  it("shows the currency symbol on zero when standalone - the exact bug this covers", () => {
    expect(formatDeltaAmount(0n, true)).toBe("$0.00");
  });

  it("omits the currency symbol on zero in a table cell", () => {
    expect(formatDeltaAmount(0n, false)).toBe("0.00");
  });

  it("shows the currency symbol on a gain, not just on zero", () => {
    expect(formatDeltaAmount(toCents("123.45"), true)).toBe("+$123.45");
  });

  it("shows the currency symbol on a loss, not just on zero", () => {
    expect(formatDeltaAmount(-toCents("123.45"), true)).toBe("−$123.45");
  });

  it("omits the currency symbol on a gain in a table cell", () => {
    expect(formatDeltaAmount(toCents("123.45"), false)).toBe("+123.45");
  });
});

describe("formatDeltaPercent", () => {
  it('shows "0.0%" with no sign for an exact zero - no change at all', () => {
    expect(formatDeltaPercent(0)).toBe("0.0%");
    // JS negative zero must not slip through as a signed "-0.0%".
    expect(formatDeltaPercent(-0)).toBe("0.0%");
  });

  it('shows "<0.1%" for a tiny loss that would otherwise round to "-0.0%"', () => {
    // The reported case: a $7.50 loss on a $15,396.50 position is -0.049%,
    // which rounds to "0.0" at one decimal - signed, that reads as a bug
    // (negative zero), not "a real but tiny loss".
    const percent = (-7.5 / 15396.5) * 100;
    expect(formatDeltaPercent(percent)).toBe("<0.1%");
  });

  it('shows "<0.1%" for a tiny gain, not "+0.0%"', () => {
    expect(formatDeltaPercent(0.03)).toBe("<0.1%");
  });

  it("never shows a sign on the <0.1% indicator - the glyph and cents amount already carry direction", () => {
    expect(formatDeltaPercent(-0.03)).toBe("<0.1%");
    expect(formatDeltaPercent(0.03)).toBe("<0.1%");
  });

  it("shows a normal signed percent once it's large enough not to round to zero", () => {
    expect(formatDeltaPercent(0.3)).toBe("+0.3%");
    expect(formatDeltaPercent(-0.3)).toBe("−0.3%");
  });

  it("rounds a value at the display boundary up to a real percent, not <0.1%", () => {
    // 0.05 rounds to "0.1" at one decimal, so it's large enough to show as
    // a real signed value rather than the near-zero indicator.
    expect(formatDeltaPercent(0.05)).toBe("+0.1%");
  });
});
