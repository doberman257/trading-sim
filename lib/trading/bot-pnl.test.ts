import { describe, expect, it } from "vitest";
import { computeBotRunRealizedPnl } from "./bot-pnl";
import { toCents } from "./money";

describe("computeBotRunRealizedPnl", () => {
  it("is positive when the exit total exceeds the entry total", () => {
    expect(computeBotRunRealizedPnl(toCents("930.00"), toCents("990.00"))).toBe(toCents("60.00"));
  });

  it("is negative when the exit total is less than the entry total", () => {
    expect(computeBotRunRealizedPnl(toCents("930.00"), toCents("900.00"))).toBe(-toCents("30.00"));
  });

  it("is zero when the exit total exactly matches the entry total", () => {
    expect(computeBotRunRealizedPnl(toCents("930.00"), toCents("930.00"))).toBe(0n);
  });
});
