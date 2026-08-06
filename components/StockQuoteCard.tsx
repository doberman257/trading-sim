import { formatCents } from "@/lib/trading/money";

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
  if (bidCents === null || askCents === null) {
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

  const spreadCents = askCents - bidCents;

  return (
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
        <span className="text-subtle font-mono text-xs tabular-nums">
          Spread ${formatCents(spreadCents)}
        </span>
      </div>
    </div>
  );
}
