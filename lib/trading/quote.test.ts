import { describe, expect, it } from "vitest";
import {
  calculateSpreadCents,
  describeMissingQuote,
  isSpreadImplausiblyWide,
  isValidTwoSidedQuote,
} from "./quote";
import { toCents } from "./money";

// Six real quotes pulled directly from Alpaca's own latest-quote endpoint
// in one sitting (bypassing this app's code entirely), all timestamped
// within ~35 seconds of each other, right at a real 4pm ET close: NVDA and
// TSLA both showed a real, single-tick, single-exchange (bx/ax both "V" -
// IEX) quote with an implausibly wide (but nonzero) spread; AAPL, MSFT,
// AMZN, and SPY showed the same single-exchange/single-timestamp shape
// with the ask side fully zeroed out instead. Used as fixtures on both
// sides of this file - the zero-ask four here, the wide-but-nonzero two
// in isSpreadImplausiblyWide below - so the exact real evidence behind
// both fixes stays in the suite, not just described in STATE.md.
const REAL_CLOSING_QUOTES = {
  NVDA: { bidCents: toCents("210.44"), askCents: toCents("232.74") },
  TSLA: { bidCents: toCents("312.71"), askCents: toCents("345.07") },
  AAPL: { bidCents: toCents("295.94"), askCents: 0n },
  MSFT: { bidCents: toCents("474.07"), askCents: 0n },
  AMZN: { bidCents: toCents("259.11"), askCents: 0n },
  SPY: { bidCents: toCents("771.64"), askCents: 0n },
} as const;

describe("isValidTwoSidedQuote", () => {
  it("is true when both sides are positive", () => {
    expect(isValidTwoSidedQuote(toCents("99.00"), toCents("100.00"))).toBe(true);
  });

  it("is false when the ask is zero", () => {
    expect(isValidTwoSidedQuote(toCents("295.94"), 0n)).toBe(false);
  });

  it("is false when the bid is zero", () => {
    expect(isValidTwoSidedQuote(0n, toCents("100.00"))).toBe(false);
  });

  it("is false when both sides are zero", () => {
    expect(isValidTwoSidedQuote(0n, 0n)).toBe(false);
  });

  it.each(["AAPL", "MSFT", "AMZN", "SPY"] as const)(
    "is false for the real %s closing-print quote (a real bid, a zeroed-out ask)",
    (symbol) => {
      const { bidCents, askCents } = REAL_CLOSING_QUOTES[symbol];
      expect(isValidTwoSidedQuote(bidCents, askCents)).toBe(false);
    },
  );
});

describe("calculateSpreadCents", () => {
  it("returns ask minus bid for a valid two-sided quote", () => {
    expect(calculateSpreadCents(toCents("99.00"), toCents("100.00"))).toBe(toCents("1.00"));
  });

  // The exact real bug this guards against: a quote with a genuine bid but
  // a zero ask (Alpaca's way of reporting no active offer, most often seen
  // while the market is closed) must never produce a negative spread -
  // "Bid $295.94, Ask $0.00, Spread -$295.94" rendered for real.
  it("returns null, not a negative number, when the ask is zero", () => {
    expect(calculateSpreadCents(toCents("295.94"), 0n)).toBeNull();
  });

  it("returns null, not a negative number, when the bid is zero", () => {
    expect(calculateSpreadCents(0n, toCents("100.00"))).toBeNull();
  });
});

describe("isSpreadImplausiblyWide", () => {
  it("is false for a normal liquid-stock spread", () => {
    expect(isSpreadImplausiblyWide(toCents("99.98"), toCents("100.02"))).toBe(false);
  });

  // NVDA and TSLA from REAL_CLOSING_QUOTES above (10.1% and 9.8%) - not
  // the zero-side case isValidTwoSidedQuote already catches, but a real,
  // single-tick, single-exchange quote with a genuinely implausible spread
  // for an otherwise penny-wide large-cap.
  it("is true for the real NVDA closing-print spread (10.1%)", () => {
    expect(
      isSpreadImplausiblyWide(REAL_CLOSING_QUOTES.NVDA.bidCents, REAL_CLOSING_QUOTES.NVDA.askCents),
    ).toBe(true);
  });

  it("is true for the real TSLA closing-print spread (9.8%)", () => {
    expect(
      isSpreadImplausiblyWide(REAL_CLOSING_QUOTES.TSLA.bidCents, REAL_CLOSING_QUOTES.TSLA.askCents),
    ).toBe(true);
  });

  // A second, independent real-data check: does this same threshold also
  // fire correctly on genuine intraday illiquidity, not just a closed-
  // market IEX artifact? Pulled real historical intraday quotes for a
  // regular session, 10:30-11:30am ET (nowhere near the open or close),
  // for names off Alpaca's own most-actives list. CELZ (a real penny
  // stock) hit a genuine 37.8% spread mid-session - not an artifact of
  // anything, just a thin real market, confirmed by checking a completely
  // different time-of-day than the closing-print cases above. SNXX, a
  // more liquid name from the very same list and the same session window,
  // stayed under 0.5% the whole time and is correctly left unflagged. This
  // is what confirms the threshold isn't secretly a "market is closed"
  // detector - it was written unconditional on market hours, and real
  // data confirms that's correct.
  it("is true for a real CELZ intraday tick with genuine (not close-related) illiquidity (37.8%)", () => {
    expect(isSpreadImplausiblyWide(toCents("1.18"), toCents("1.73"))).toBe(true);
  });

  it("is false for a real SNXX intraday tick from a genuinely liquid stock (0.45%)", () => {
    expect(isSpreadImplausiblyWide(toCents("8.88"), toCents("8.92"))).toBe(false);
  });

  it("is false right at the threshold and true just past it", () => {
    // mid = 100.00, so exactly 3.00 is exactly 300bps of mid.
    expect(isSpreadImplausiblyWide(toCents("98.50"), toCents("101.50"))).toBe(false);
    expect(isSpreadImplausiblyWide(toCents("98.49"), toCents("101.51"))).toBe(true);
  });

  it("is false for an invalid (zero-sided) quote - that's isValidTwoSidedQuote's job, not this one's", () => {
    expect(
      isSpreadImplausiblyWide(REAL_CLOSING_QUOTES.AAPL.bidCents, REAL_CLOSING_QUOTES.AAPL.askCents),
    ).toBe(false);
  });
});

describe("describeMissingQuote", () => {
  it("says the market is closed, not that the price is 'unavailable', when the market is closed", () => {
    expect(describeMissingQuote(["INTC"], false)).toBe(
      "Market closed - the value of INTC isn't shown until trading resumes.",
    );
  });

  // The rarer, more concerning case (see the closing-bell investigation
  // this session extended into intraday hours) - must never claim the
  // market is closed when it isn't.
  it("does not claim the market is closed when it's actually open", () => {
    const message = describeMissingQuote(["INTC"], true);
    expect(message).toBe("The live price of INTC isn't available right now.");
    expect(message).not.toMatch(/market closed/i);
  });

  it("lists every symbol, not just the first, for more than one missing quote", () => {
    expect(describeMissingQuote(["INTC", "AAPL"], false)).toBe(
      "Market closed - the value of INTC, AAPL isn't shown until trading resumes.",
    );
  });
});
