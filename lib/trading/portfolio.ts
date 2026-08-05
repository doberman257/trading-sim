import { valuePosition } from "./pnl";
import type { Cents, Shares } from "./money";
import type { Quote } from "./types";

export type PortfolioPosition = {
  symbol: string;
  quantity: Shares;
  avgCostCents: Cents;
};

// A quote lookup only needs the side used for mark-to-market valuation, not
// the full Quote shape - keeps this pure function decoupled from however the
// caller sourced its quotes.
export type QuoteLookup = ReadonlyMap<string, Pick<Quote, "bidCents">>;

export type PositionValuation = {
  symbol: string;
  quantity: Shares;
  avgCostCents: Cents;
  // All four fields below are null together when no quote was available for
  // this symbol - see the "missing quote" note above calculatePortfolio.
  currentPriceCents: Cents | null;
  marketValueCents: Cents | null;
  unrealizedPnlCents: Cents | null;
  unrealizedPnlPercent: number | null;
};

export type PortfolioValuation = {
  positions: PositionValuation[];
  totalMarketValueCents: Cents;
  totalEquityCents: Cents;
  totalUnrealizedPnlCents: Cents;
  // Symbols held in the portfolio that had no quote available. Totals above
  // are computed only from positions that DID have a quote - see the note
  // above calculatePortfolio for why this list exists instead of the totals
  // silently including a zero for these symbols.
  missingQuoteSymbols: string[];
};

// Mark-to-market uses the bid price, not the ask: it answers "what could
// this position actually be sold for right now", and sells fill at bid
// (see lib/trading/execute.ts). Using ask here would overstate every
// position's value by the spread.
//
// A missing quote is represented as null across all four valuation fields
// for that position, not as zero. Zero would render as "this position is
// worthless", which is a false and much stronger claim than "we don't know
// its current price" - the two must never look the same to the user. The
// portfolio totals then exclude that position's (unknown) contribution
// entirely rather than assuming it's zero, and report it separately via
// missingQuoteSymbols so the caller can mark the totals as partial instead
// of presenting them as complete.
// Takes cashCents as a third argument (rather than folding it into
// `positions`) because total equity - cash plus market value - can't be
// computed without it, and a bare positions array shouldn't be overloaded
// into "a positions array that secretly also carries the account's cash".
export function calculatePortfolio(
  positions: readonly PortfolioPosition[],
  cashCents: Cents,
  quotes: QuoteLookup,
): PortfolioValuation {
  const valuations: PositionValuation[] = [];
  const missingQuoteSymbols: string[] = [];
  let totalMarketValueCents = 0n;
  let totalUnrealizedPnlCents = 0n;

  for (const position of positions) {
    const quote = quotes.get(position.symbol);

    if (!quote) {
      missingQuoteSymbols.push(position.symbol);
      valuations.push({
        symbol: position.symbol,
        quantity: position.quantity,
        avgCostCents: position.avgCostCents,
        currentPriceCents: null,
        marketValueCents: null,
        unrealizedPnlCents: null,
        unrealizedPnlPercent: null,
      });
      continue;
    }

    const { marketValueCents, unrealizedPnlCents, unrealizedPnlPercent } = valuePosition(
      position.avgCostCents,
      quote.bidCents,
      position.quantity,
    );

    totalMarketValueCents += marketValueCents;
    totalUnrealizedPnlCents += unrealizedPnlCents;

    valuations.push({
      symbol: position.symbol,
      quantity: position.quantity,
      avgCostCents: position.avgCostCents,
      currentPriceCents: quote.bidCents,
      marketValueCents,
      unrealizedPnlCents,
      unrealizedPnlPercent,
    });
  }

  return {
    positions: valuations,
    totalMarketValueCents,
    totalEquityCents: cashCents + totalMarketValueCents,
    totalUnrealizedPnlCents,
    missingQuoteSymbols,
  };
}
