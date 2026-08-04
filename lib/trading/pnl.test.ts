import { describe, expect, it } from "vitest";
import { toCents } from "./money";
import { valuePosition } from "./pnl";

describe("valuePosition", () => {
  it("computes market value as price times quantity", () => {
    const result = valuePosition(toCents("150.00"), toCents("178.32"), 50);
    expect(result.marketValueCents).toBe(toCents("8916.00"));
  });

  it("computes a positive unrealized P&L when price is above average cost", () => {
    const result = valuePosition(toCents("150.00"), toCents("178.32"), 50);
    expect(result.unrealizedPnlCents).toBe(toCents("1416.00"));
    expect(result.unrealizedPnlPercent).toBeCloseTo(18.88, 1);
  });

  it("computes a negative unrealized P&L when price is below average cost", () => {
    const result = valuePosition(toCents("250.00"), toCents("210.15"), 20);
    expect(result.unrealizedPnlCents).toBe(-toCents("797.00"));
    expect(result.unrealizedPnlPercent).toBeCloseTo(-15.94, 1);
  });

  it("computes a zero unrealized P&L when price equals average cost", () => {
    const result = valuePosition(toCents("100.00"), toCents("100.00"), 10);
    expect(result.unrealizedPnlCents).toBe(0n);
    expect(result.unrealizedPnlPercent).toBe(0);
  });

  it("does not divide by zero when average cost is zero", () => {
    const result = valuePosition(0n, toCents("10.00"), 5);
    expect(result.unrealizedPnlPercent).toBe(0);
  });
});
