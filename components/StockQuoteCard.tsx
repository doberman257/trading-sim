import { formatCents } from "@/lib/trading/money";
import {
  calculateSpreadCents,
  describeWideSpreadWarning,
  isSpreadImplausiblyWide,
} from "@/lib/trading/quote";

export type StockQuoteCardProps = {
  symbol: string;
  // Null together when no live quote came back for this symbol - see the
  // stock detail page's use of fetchQuotes' failedSymbols. Never presented
  // as a price of zero.
  bidCents: bigint | null;
  askCents: bigint | null;
  /** True when the market is closed - see MarketStatusBanner. */
  isStale: boolean;
};

// Never a single "current price" - bid and ask are always shown side by
// side, per the hard rule that the spread must be modeled. This is a
// browsing/decision display, not an order fill, but the same discipline
// avoids implying a single true price exists.
export function StockQuoteCard({ symbol, bidCents, askCents, isStale }: StockQuoteCardProps) {
  // calculateSpreadCents is also where lib/market/alpaca.ts's own
  // fetchQuote(s) already reject a zero-priced side, so bidCents/askCents
  // getting here at all should mean both are genuinely valid - this is a
  // second, defense-in-depth check at the display boundary, not the
  // primary fix, for the exact reason a defense-in-depth check is ever
  // worth having: a future caller of this component that doesn't go
  // through fetchQuote(s) shouldn't be able to render a negative spread
  // just by skipping a guard nobody told it existed.
  const spreadCents =
    bidCents !== null && askCents !== null ? calculateSpreadCents(bidCents, askCents) : null;

  if (bidCents === null || askCents === null || spreadCents === null) {
    return (
      <div
        role="alert"
        className="border-warn/30 bg-warn/5 text-warn rounded-md border px-3 py-2 text-sm"
      >
        No live price available for {symbol} right now. It may be delisted or temporarily
        unavailable - trading is disabled until a price comes back.
      </div>
    );
  }

  const wideSpread = isSpreadImplausiblyWide(bidCents, askCents);

  return (
    <div>
      <div className={`flex items-end gap-6 ${isStale ? "opacity-60" : ""}`}>
        <div>
          <div className="text-muted text-xs">Bid</div>
          <div className="text-fg font-mono text-2xl tabular-nums">${formatCents(bidCents)}</div>
        </div>
        <div>
          <div className="text-muted text-xs">Ask</div>
          <div className="text-fg font-mono text-2xl tabular-nums">${formatCents(askCents)}</div>
        </div>
        <div className="pb-1.5">
          <span
            className={
              wideSpread
                ? "text-warn font-mono text-xs tabular-nums"
                : "text-subtle font-mono text-xs tabular-nums"
            }
          >
            Spread ${formatCents(spreadCents)}
          </span>
        </div>
      </div>
      {wideSpread && (
        <p className="text-warn mt-1 text-xs leading-snug">{describeWideSpreadWarning(symbol)}</p>
      )}
    </div>
  );
}
