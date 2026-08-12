import { describe, expect, it } from "vitest";
import {
  computeProfitTargetLimitPriceCents,
  isProfitTargetHit,
  isStopLossHit,
  resolveTargetCents,
  validateTargetConfig,
  type TargetConfig,
} from "./bot-targets";
import { toCents } from "./money";

describe("resolveTargetCents", () => {
  it("resolves a dollar target to its own fixed value, ignoring entry cost", () => {
    const config: TargetConfig = { type: "dollar", valueCents: toCents("75.00") };
    expect(resolveTargetCents(config, toCents("930.00"))).toBe(toCents("75.00"));
  });

  it("resolves a percent target against the entry cost", () => {
    const config: TargetConfig = { type: "percent", basisPoints: 500 }; // 5%
    expect(resolveTargetCents(config, toCents("1000.00"))).toBe(toCents("50.00"));
  });
});

describe("isProfitTargetHit / isStopLossHit", () => {
  const entryTotalCents = toCents("1000.00");
  const dollarTarget: TargetConfig = { type: "dollar", valueCents: toCents("50.00") };

  it("profit target fires once unrealized P&L reaches the target, not before", () => {
    expect(isProfitTargetHit(toCents("49.00"), dollarTarget, entryTotalCents)).toBe(false);
    expect(isProfitTargetHit(toCents("50.00"), dollarTarget, entryTotalCents)).toBe(true);
    expect(isProfitTargetHit(toCents("60.00"), dollarTarget, entryTotalCents)).toBe(true);
  });

  it("stop-loss fires once unrealized P&L drops to minus the target, not before", () => {
    const stopLoss: TargetConfig = { type: "dollar", valueCents: toCents("30.00") };
    expect(isStopLossHit(-toCents("29.00"), stopLoss, entryTotalCents)).toBe(false);
    expect(isStopLossHit(-toCents("30.00"), stopLoss, entryTotalCents)).toBe(true);
    expect(isStopLossHit(-toCents("40.00"), stopLoss, entryTotalCents)).toBe(true);
  });

  it("a real gain never accidentally reads as a stop-loss hit", () => {
    const stopLoss: TargetConfig = { type: "dollar", valueCents: toCents("30.00") };
    expect(isStopLossHit(toCents("100.00"), stopLoss, entryTotalCents)).toBe(false);
  });
});

describe("computeProfitTargetLimitPriceCents", () => {
  it("rounds up so the resting limit sell guarantees at least the target profit", () => {
    // $930.00 entry, quantity 3, target $50.00 -> raw total $980.00 / 3 =
    // $326.666... per share - must round up to $326.67, never down to
    // $326.66 (3 * $326.66 = $979.98, one cent short of the guarantee).
    const result = computeProfitTargetLimitPriceCents(toCents("930.00"), 3, {
      type: "dollar",
      valueCents: toCents("50.00"),
    });
    expect(result).toBe(toCents("326.67"));
  });

  it("does not round up when the division is already exact", () => {
    const result = computeProfitTargetLimitPriceCents(toCents("1000.00"), 10, {
      type: "dollar",
      valueCents: toCents("50.00"),
    });
    expect(result).toBe(toCents("105.00"));
  });
});

describe("validateTargetConfig", () => {
  const capitalCents = toCents("1000.00");

  it("rejects a zero or negative dollar amount", () => {
    expect(validateTargetConfig({ type: "dollar", valueCents: 0n }, capitalCents)).toBe(
      "invalid_dollar_amount",
    );
    expect(
      validateTargetConfig({ type: "dollar", valueCents: -toCents("1.00") }, capitalCents),
    ).toBe("invalid_dollar_amount");
  });

  it("rejects a dollar amount larger than the capital committed", () => {
    expect(
      validateTargetConfig({ type: "dollar", valueCents: toCents("1000.01") }, capitalCents),
    ).toBe("dollar_amount_exceeds_capital");
  });

  it("accepts a dollar amount up to and including the full capital", () => {
    expect(
      validateTargetConfig({ type: "dollar", valueCents: toCents("1000.00") }, capitalCents),
    ).toBeNull();
  });

  it("rejects a zero, negative, or >=100% percent", () => {
    expect(validateTargetConfig({ type: "percent", basisPoints: 0 }, capitalCents)).toBe(
      "invalid_percent",
    );
    expect(validateTargetConfig({ type: "percent", basisPoints: -100 }, capitalCents)).toBe(
      "invalid_percent",
    );
    expect(validateTargetConfig({ type: "percent", basisPoints: 10_000 }, capitalCents)).toBe(
      "invalid_percent",
    );
  });

  it("accepts a normal percent value", () => {
    expect(validateTargetConfig({ type: "percent", basisPoints: 500 }, capitalCents)).toBeNull();
  });
});
