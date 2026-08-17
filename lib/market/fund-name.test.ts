import { describe, expect, it } from "vitest";
import { isLikelyFundOrDerivativeName } from "./fund-name";

describe("isLikelyFundOrDerivativeName", () => {
  // Real names pulled directly from the synced assets table, not invented -
  // see the bot-watchlist curation script's own verification.
  it("flags real ETF/fund/trust names from the synced assets table", () => {
    expect(isLikelyFundOrDerivativeName("Founders 100 ETF")).toBe(true);
    expect(isLikelyFundOrDerivativeName("Eldridge AAA CLO ETF")).toBe(true);
    expect(isLikelyFundOrDerivativeName("Tortoise MLP ETF")).toBe(true);
    expect(isLikelyFundOrDerivativeName("Invesco Solar ETF")).toBe(true);
    expect(isLikelyFundOrDerivativeName("iShares 10-20 Year Treasury Bond ETF")).toBe(true);
    expect(
      isLikelyFundOrDerivativeName("COtwo Advisors Physical European Carbon Allowance Trust"),
    ).toBe(true);
  });

  it("flags warrant, unit, and leveraged/inverse naming conventions", () => {
    expect(isLikelyFundOrDerivativeName("Example Acquisition Corp Warrants")).toBe(true);
    expect(isLikelyFundOrDerivativeName("Example Acquisition Corp Units")).toBe(true);
    expect(isLikelyFundOrDerivativeName("Direxion Daily Semiconductor Bull 3X Shares")).toBe(true);
    expect(isLikelyFundOrDerivativeName("ProShares UltraPro Short QQQ")).toBe(true);
  });

  it("does not flag ordinary operating-company names", () => {
    expect(isLikelyFundOrDerivativeName("Apple Inc.")).toBe(false);
    expect(isLikelyFundOrDerivativeName("UDR, Inc.")).toBe(false);
    expect(isLikelyFundOrDerivativeName("ABM Industries, Inc.")).toBe(false);
    expect(isLikelyFundOrDerivativeName("SLB Limited")).toBe(false);
    expect(isLikelyFundOrDerivativeName("New York Times Co.")).toBe(false);
    expect(isLikelyFundOrDerivativeName("Archer Aviation Inc.")).toBe(false);
  });

  it("does not flag real S&P 500 companies whose legal name happens to start with a fund-issuer's brand", () => {
    // Charles Schwab Corporation (SCHW) and JPMorgan Chase & Co. (JPM) are
    // both real S&P 500 constituents, not funds - the issuer-prefix patterns
    // are anchored to the issuer's own bare product-line naming ("Schwab...",
    // "JPMorgan Equity...") specifically so these don't collide.
    expect(isLikelyFundOrDerivativeName("Charles Schwab Corporation")).toBe(false);
    expect(isLikelyFundOrDerivativeName("JPMorgan Chase & Co.")).toBe(false);
  });

  // A real, confirmed limitation, not a hypothetical - documented on the
  // function itself: "Trust" alone can't distinguish a literal trust
  // vehicle from a REIT or bank whose own legal name contains the word.
  // Four real S&P 500 constituents hit this exact case (found by checking
  // the real reference data, not assumed) - recorded here so a future
  // reader sees this is known, not an oversight, and callers using this
  // function against an already-index-verified universe should treat a
  // match as "worth a manual look", never as an automatic exclusion.
  it("flags real S&P 500 operating companies whose legal name contains Trust - a known false-positive class, not a bug", () => {
    expect(isLikelyFundOrDerivativeName("Northern Trust")).toBe(true);
    expect(isLikelyFundOrDerivativeName("Camden Property Trust")).toBe(true);
    expect(isLikelyFundOrDerivativeName("Federal Realty Investment Trust")).toBe(true);
  });
});
