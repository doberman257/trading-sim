import { describe, expect, it } from "vitest";
import { shouldFillLimitOrder } from "./limit-fill";
import { toCents } from "./money";

describe("shouldFillLimitOrder", () => {
  describe("buy", () => {
    it("fills when the ask is below the limit price", () => {
      expect(
        shouldFillLimitOrder(
          { side: "buy", limitPriceCents: toCents("100.00") },
          { bidCents: toCents("98.00"), askCents: toCents("99.00") },
        ),
      ).toBe(true);
    });

    it("fills when the ask is exactly equal to the limit price - inclusive, not strict", () => {
      expect(
        shouldFillLimitOrder(
          { side: "buy", limitPriceCents: toCents("100.00") },
          { bidCents: toCents("99.00"), askCents: toCents("100.00") },
        ),
      ).toBe(true);
    });

    it("does not fill when the ask is above the limit price", () => {
      expect(
        shouldFillLimitOrder(
          { side: "buy", limitPriceCents: toCents("100.00") },
          { bidCents: toCents("100.50"), askCents: toCents("100.01") },
        ),
      ).toBe(false);
    });
  });

  describe("sell", () => {
    it("fills when the bid is above the limit price", () => {
      expect(
        shouldFillLimitOrder(
          { side: "sell", limitPriceCents: toCents("100.00") },
          { bidCents: toCents("101.00"), askCents: toCents("102.00") },
        ),
      ).toBe(true);
    });

    it("fills when the bid is exactly equal to the limit price - inclusive, not strict", () => {
      expect(
        shouldFillLimitOrder(
          { side: "sell", limitPriceCents: toCents("100.00") },
          { bidCents: toCents("100.00"), askCents: toCents("101.00") },
        ),
      ).toBe(true);
    });

    it("does not fill when the bid is below the limit price", () => {
      expect(
        shouldFillLimitOrder(
          { side: "sell", limitPriceCents: toCents("100.00") },
          { bidCents: toCents("99.99"), askCents: toCents("100.50") },
        ),
      ).toBe(false);
    });
  });

  // A buy's fill condition only ever looks at the ask, a sell's only ever
  // at the bid - the other side of the quote being wildly out of range
  // must never accidentally influence the decision (e.g. a bug that
  // compared against the wrong side, or against a computed mid-price).
  it("ignores the bid entirely for a buy decision", () => {
    expect(
      shouldFillLimitOrder(
        { side: "buy", limitPriceCents: toCents("100.00") },
        { bidCents: toCents("1.00"), askCents: toCents("99.00") },
      ),
    ).toBe(true);
  });

  it("ignores the ask entirely for a sell decision", () => {
    expect(
      shouldFillLimitOrder(
        { side: "sell", limitPriceCents: toCents("100.00") },
        { bidCents: toCents("101.00"), askCents: toCents("9999.00") },
      ),
    ).toBe(true);
  });
});
