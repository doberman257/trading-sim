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
  // Smaller type, tighter spacing - for use inside a narrow 320px order
  // ticket (see OrderTicket.tsx) rather than the page-level, full-width
  // display this component was originally built for. Same component, same
  // underlying logic either way, per the explicit "one component, prop-
  // controlled" preference over a second near-duplicate - only the sizing
  // changes.
  compact?: boolean;
  // A limit order's whole point is to ignore the current spread and wait
  // for its own price - the wide-spread caveat is only actionable for an
  // order that would transact against the CURRENT quote right now, i.e. a
  // market order. Defaults to true (unchanged behavior for every existing
  // page-level usage); OrderTicket passes false while placing a limit order.
  showWideSpreadWarning?: boolean;
};

// Never a single "current price" - bid and ask are always shown side by
// side, per the hard rule that the spread must be modeled. This is a
// browsing/decision display, not an order fill, but the same discipline
// avoids implying a single true price exists.
export function StockQuoteCard({
  symbol,
  bidCents,
  askCents,
  isStale,
  compact = false,
  showWideSpreadWarning = true,
}: StockQuoteCardProps) {
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
  const priceSizeClassName = compact ? "text-lg" : "text-2xl";

  return (
    <div>
      <div
        className={`flex items-end ${compact ? "gap-4" : "gap-6"} ${isStale ? "opacity-60" : ""}`}
      >
        <div>
          <div className="text-muted text-xs">Bid</div>
          <div className={`text-fg font-mono tabular-nums ${priceSizeClassName}`}>
            ${formatCents(bidCents)}
          </div>
        </div>
        <div>
          <div className="text-muted text-xs">Ask</div>
          <div className={`text-fg font-mono tabular-nums ${priceSizeClassName}`}>
            ${formatCents(askCents)}
          </div>
        </div>
        <div className={compact ? "pb-1" : "pb-1.5"}>
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
      {wideSpread && showWideSpreadWarning && (
        <p className="text-warn mt-1 text-xs leading-snug">{describeWideSpreadWarning(symbol)}</p>
      )}
    </div>
  );
}
