import { describe, expect, it } from "vitest";
import { calculateAllocation } from "./allocation";
import { toCents } from "./money";

describe("calculateAllocation", () => {
  it("splits equity between positions and cash by percent", () => {
    const slices = calculateAllocation(
      [{ symbol: "AAPL", marketValueCents: toCents("6000.00") }],
      toCents("4000.00"),
      toCents("10000.00"),
    );

    expect(slices).toEqual([
      { label: "AAPL", kind: "position", valueCents: toCents("6000.00"), percent: 60 },
      { label: "Cash", kind: "cash", valueCents: toCents("4000.00"), percent: 40 },
    ]);
  });

  it("sorts positions largest-to-smallest by market value, with cash always last", () => {
    const slices = calculateAllocation(
      [
        { symbol: "AAPL", marketValueCents: toCents("1000.00") },
        { symbol: "TSLA", marketValueCents: toCents("5000.00") },
        { symbol: "MSFT", marketValueCents: toCents("2000.00") },
      ],
      toCents("2000.00"),
      toCents("10000.00"),
    );

    expect(slices.map((slice) => slice.label)).toEqual(["TSLA", "MSFT", "AAPL", "Cash"]);
    expect(slices.at(-1)?.kind).toBe("cash");
  });

  it("excludes a position with no live quote rather than showing it as zero", () => {
    const slices = calculateAllocation(
      [
        { symbol: "AAPL", marketValueCents: toCents("6000.00") },
        { symbol: "GOOG", marketValueCents: null },
      ],
      toCents("4000.00"),
      // totalEquityCents already excludes GOOG's unknown contribution -
      // calculatePortfolio (lib/trading/portfolio.ts) guarantees this.
      toCents("10000.00"),
    );

    expect(slices.map((slice) => slice.label)).toEqual(["AAPL", "Cash"]);
    expect(slices.map((slice) => slice.percent)).toEqual([60, 40]);
  });

  it("always includes a Cash slice, even when cash is zero", () => {
    const slices = calculateAllocation(
      [{ symbol: "AAPL", marketValueCents: toCents("10000.00") }],
      0n,
      toCents("10000.00"),
    );

    expect(slices).toEqual([
      { label: "AAPL", kind: "position", valueCents: toCents("10000.00"), percent: 100 },
      { label: "Cash", kind: "cash", valueCents: 0n, percent: 0 },
    ]);
  });

  it("does not divide by zero when total equity is zero", () => {
    const slices = calculateAllocation([], 0n, 0n);

    expect(slices).toEqual([{ label: "Cash", kind: "cash", valueCents: 0n, percent: 0 }]);
  });

  it("compares market values numerically, not lexicographically, when sorting", () => {
    // Guards against the class of bug fixed in isUpBar (stockChartFormat.ts):
    // a cents value of "10050" must sort above "9999" numerically even
    // though it would not as a string.
    const slices = calculateAllocation(
      [
        { symbol: "SMALL", marketValueCents: 9999n },
        { symbol: "BIG", marketValueCents: 10050n },
      ],
      0n,
      20049n,
    );

    expect(slices.map((slice) => slice.label)).toEqual(["BIG", "SMALL", "Cash"]);
  });
});
