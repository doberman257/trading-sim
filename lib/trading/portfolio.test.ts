import { describe, expect, it } from "vitest";
import { calculatePortfolio, type PortfolioPosition, type QuoteLookup } from "./portfolio";
import { toCents } from "./money";

function quotes(entries: Record<string, string>): QuoteLookup {
  return new Map(
    Object.entries(entries).map(([symbol, bid]) => [symbol, { bidCents: toCents(bid) }]),
  );
}

describe("calculatePortfolio", () => {
  it("computes market value and a positive unrealized P&L for a position in profit", () => {
    const positions: PortfolioPosition[] = [
      { symbol: "AAPL", quantity: 10, avgCostCents: toCents("100.00") },
    ];
    const result = calculatePortfolio(positions, toCents("5000.00"), quotes({ AAPL: "120.00" }));

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({
      currentPriceCents: toCents("120.00"),
      marketValueCents: toCents("1200.00"),
      unrealizedPnlCents: toCents("200.00"),
    });
    expect(result.positions[0]?.unrealizedPnlPercent).toBeCloseTo(20, 5);
    expect(result.totalMarketValueCents).toBe(toCents("1200.00"));
    expect(result.totalUnrealizedPnlCents).toBe(toCents("200.00"));
    expect(result.totalEquityCents).toBe(toCents("5000.00") + toCents("1200.00"));
    expect(result.missingQuoteSymbols).toEqual([]);
  });

  it("computes a negative unrealized P&L for a position at a loss", () => {
    const positions: PortfolioPosition[] = [
      { symbol: "TSLA", quantity: 20, avgCostCents: toCents("250.00") },
    ];
    const result = calculatePortfolio(positions, toCents("1000.00"), quotes({ TSLA: "210.15" }));

    expect(result.positions[0]?.unrealizedPnlCents).toBe(-toCents("797.00"));
    expect(result.totalUnrealizedPnlCents).toBe(-toCents("797.00"));
    expect(result.totalEquityCents).toBe(toCents("1000.00") + result.totalMarketValueCents);
  });

  it("computes exactly zero unrealized P&L when the quote equals average cost", () => {
    const positions: PortfolioPosition[] = [
      { symbol: "MSFT", quantity: 5, avgCostCents: toCents("300.00") },
    ];
    const result = calculatePortfolio(positions, toCents("0.00"), quotes({ MSFT: "300.00" }));

    expect(result.positions[0]?.unrealizedPnlCents).toBe(0n);
    expect(result.positions[0]?.unrealizedPnlPercent).toBe(0);
    expect(result.totalUnrealizedPnlCents).toBe(0n);
  });

  it("returns all-zero totals and no positions for an empty portfolio", () => {
    const result = calculatePortfolio([], toCents("100.00"), quotes({}));

    expect(result.positions).toEqual([]);
    expect(result.totalMarketValueCents).toBe(0n);
    expect(result.totalUnrealizedPnlCents).toBe(0n);
    expect(result.totalEquityCents).toBe(toCents("100.00"));
    expect(result.missingQuoteSymbols).toEqual([]);
  });

  it("represents a position with no available quote as null, not zero, and excludes it from totals", () => {
    const positions: PortfolioPosition[] = [
      { symbol: "GOOG", quantity: 3, avgCostCents: toCents("150.00") },
    ];
    const result = calculatePortfolio(positions, toCents("1000.00"), quotes({}));

    expect(result.positions[0]).toMatchObject({
      currentPriceCents: null,
      marketValueCents: null,
      unrealizedPnlCents: null,
      unrealizedPnlPercent: null,
    });
    // Not zero: a zero market value would claim the position is worthless,
    // which is a stronger and false claim compared to "price unknown".
    expect(result.totalMarketValueCents).toBe(0n);
    expect(result.totalUnrealizedPnlCents).toBe(0n);
    // Total equity is cash-only here, and missingQuoteSymbols is what tells
    // the caller this total is partial rather than a true zero-stock total.
    expect(result.totalEquityCents).toBe(toCents("1000.00"));
    expect(result.missingQuoteSymbols).toEqual(["GOOG"]);
  });

  it("mixes a priced position and a missing-quote position: totals reflect only the priced one", () => {
    const positions: PortfolioPosition[] = [
      { symbol: "AAPL", quantity: 10, avgCostCents: toCents("100.00") },
      { symbol: "GOOG", quantity: 3, avgCostCents: toCents("150.00") },
    ];
    const result = calculatePortfolio(positions, toCents("0.00"), quotes({ AAPL: "120.00" }));

    expect(result.totalMarketValueCents).toBe(toCents("1200.00"));
    expect(result.missingQuoteSymbols).toEqual(["GOOG"]);
    expect(result.positions.find((p) => p.symbol === "GOOG")?.marketValueCents).toBeNull();
  });
});
