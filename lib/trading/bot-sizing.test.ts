import { describe, expect, it } from "vitest";
import { computeBotOrderQuantity } from "./bot-sizing";
import { toCents } from "./money";

describe("computeBotOrderQuantity", () => {
  it("the $1000/$310-stock rounding-remainder case: buys 3 shares, spends $930, not $1000", () => {
    const result = computeBotOrderQuantity(toCents("1000.00"), toCents("310.00"));
    expect(result).toEqual({ quantity: 3, entryTotalCents: toCents("930.00") });
  });

  it("buys the exact quantity when capital divides the price evenly", () => {
    const result = computeBotOrderQuantity(toCents("1000.00"), toCents("100.00"));
    expect(result).toEqual({ quantity: 10, entryTotalCents: toCents("1000.00") });
  });

  it("returns null when the budget cannot afford even one share", () => {
    const result = computeBotOrderQuantity(toCents("1000.00"), toCents("2000.00"));
    expect(result).toBeNull();
  });

  it("returns null for a zero or negative ask (never divide by a nonsensical price)", () => {
    expect(computeBotOrderQuantity(toCents("1000.00"), 0n)).toBeNull();
    expect(computeBotOrderQuantity(toCents("1000.00"), -toCents("1.00"))).toBeNull();
  });
});
