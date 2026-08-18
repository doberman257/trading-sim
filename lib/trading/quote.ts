import type { Cents } from "./money";

// A quote is only meaningful if both sides are genuinely present. Alpaca
// reports 0 for a side with no active quotation right now (confirmed the
// real cause of a real bug: Bid $295.94 / Ask $0.00 while the market was
// closed) - that's "no market", not a real price of zero. Treated
// identically to a missing quote everywhere this is checked, so a spread,
// a fill, or a position value is never computed from a one-sided quote.
export function isValidTwoSidedQuote(bidCents: Cents, askCents: Cents): boolean {
  return bidCents > 0n && askCents > 0n;
}

// The bid-ask spread, or null when there isn't a valid two-sided quote to
// compute one from - callers must render null the same way they'd render a
// missing quote (a "no live price" state), never as a negative number.
export function calculateSpreadCents(bidCents: Cents, askCents: Cents): Cents | null {
  if (!isValidTwoSidedQuote(bidCents, askCents)) {
    return null;
  }
  return askCents - bidCents;
}

// 300 basis points (3%): comfortably above any liquid stock's normal
// continuous-market spread (fractions of a percent), comfortably below
// every real case this guards against - and confirmed, empirically, to
// generalize across two genuinely different causes, not just the one it
// was first written for:
//
// (1) A closing-bell IEX artifact on an otherwise tight large-cap. Pulled
// Alpaca's raw latest-quote response directly for six liquid symbols at
// once: NVDA (10.1% spread) and TSLA (9.8%) both showed a real,
// single-tick, single-exchange (bx/ax both "V" - IEX) quote with an
// implausibly wide spread, and AAPL/MSFT/AMZN/SPY showed the same
// single-exchange/single-timestamp pattern with the ask side fully zeroed
// out instead (see isValidTwoSidedQuote above) - all six captured within
// the same ~35 seconds, all timestamped right at the 4:00pm ET close. This
// account's free data plan only sees IEX, and IEX's own book is genuinely
// thin right at the close, since most of a stock's real closing volume
// clears through the primary listing exchange's closing auction, not IEX.
//
// (2) Genuine intraday illiquidity on a real penny/microcap - a completely
// different cause, checked separately rather than assumed to behave the
// same way. Pulled real historical intraday quotes from a regular session,
// 10:30-11:30am ET (nowhere near the open or close), for several
// low-priced names off Alpaca's own most-actives list: RCON averaged an
// 18.95% spread that session (one tick hit 62%), VIVS averaged 30.43% (one
// tick hit 169.5%) - real, continuously-quoted, genuinely thin markets,
// not an artifact of anything. Two more liquid names from the same list
// and the same window, SNXX and SPCH, stayed under 0.5% average the whole
// time. So the threshold isn't just a "market is closed" detector - it
// correctly fires on real thin liquidity whenever it occurs and correctly
// stays quiet on real liquid markets regardless of time of day, which is
// why it was written (and stays) unconditional on market hours rather than
// gated by isMarketOpen/isStale.
const WIDE_SPREAD_BASIS_POINTS = 300n;

// True when a valid two-sided quote's spread is wide enough to be worth a
// caveat, regardless of why - deliberately unconditional on whether the
// market is open (see the confirmation above that it fires correctly in
// both a closed-market artifact and genuine intraday illiquidity). A flag,
// not a rejection: unlike a zero-priced side (unambiguously invalid), a
// wide spread is still a genuine quote - a real, if illiquid or unusually
// volatile, stock can legitimately have one. Callers should surface this
// as a caveat on real data, not hide it behind a "no live price" state the
// way an invalid quote is hidden.
export function isSpreadImplausiblyWide(bidCents: Cents, askCents: Cents): boolean {
  const spreadCents = calculateSpreadCents(bidCents, askCents);
  if (spreadCents === null) return false;

  const midCents = (bidCents + askCents) / 2n;
  if (midCents <= 0n) return false;

  return spreadCents * 10_000n > midCents * WIDE_SPREAD_BASIS_POINTS;
}

// Shared wording so the caveat reads identically wherever a spread is
// shown (StockQuoteCard, OrderTicket's estimate) rather than drifting
// between call sites - same reasoning as MarketStatusBanner's
// openMessage/closedMessage. Names both confirmed causes rather than just
// the first one found (a single-exchange data feed, or the stock's own
// real illiquidity) - the NVDA/AAPL-style closing-bell case and the real
// penny-stock case above are both genuine, and the wording shouldn't imply
// one explanation covers a case it doesn't.
export function describeWideSpreadWarning(symbol: string): string {
  return `${symbol}'s bid-ask spread looks unusually wide right now. This can mean the stock itself has thin or volatile liquidity, or that this app's free single-exchange (IEX) data feed isn't seeing the full market's best price - most noticeable right around the close. Either way, treat this price with extra caution.`;
}

// Shared wording for a held position (or several) whose live quote is
// currently unavailable (calculatePortfolio's missingQuoteSymbols,
// lib/trading/portfolio.ts) - same reasoning as describeWideSpreadWarning
// above: one function so SummaryPanel, PositionRow, and PositionCard all
// read identically instead of drifting into near-duplicate copies.
//
// Deliberately distinguishes "the market is closed" from "the market is
// open and a quote is still missing", rather than using one generic
// message for both. This app keeps no quote cache (every fetch is live -
// see the caching rules in CLAUDE.md), so a missing quote while the market
// is closed is the expected, overwhelmingly common case, not a problem -
// wording it as an error ("price unavailable") reads as broken when it
// isn't. A missing quote while the market is genuinely open is a real,
// separate, and rarer condition (the kind investigated in STATE.md's
// closing-bell/IEX findings extending into intraday hours) - it must never
// be worded as "market closed" when the market is not, in fact, closed.
export function describeMissingQuote(symbols: readonly string[], marketOpen: boolean): string {
  const list = symbols.join(", ");
  return marketOpen
    ? `The live price of ${list} isn't available right now.`
    : `Market closed - the value of ${list} isn't shown until trading resumes.`;
}
