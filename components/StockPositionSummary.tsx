import { Delta } from "./Delta";
import { formatCents } from "@/lib/trading/money";
import { valuePosition } from "@/lib/trading/pnl";

export type StockPositionSummaryProps = {
  quantity: number;
  avgCostCents: bigint;
  // Null when no live quote is available - see StockQuoteCard. Market value
  // and P&L can't be computed without a current price, so they're omitted
  // rather than shown as stale or zero.
  bidCents: bigint | null;
};

export function StockPositionSummary({
  quantity,
  avgCostCents,
  bidCents,
}: StockPositionSummaryProps) {
  const valuation = bidCents !== null ? valuePosition(avgCostCents, bidCents, quantity) : null;

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Your position</h2>
      </header>
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between py-1">
          <span className="text-muted text-xs">Quantity</span>
          <span className="text-fg font-mono text-sm tabular-nums">{quantity}</span>
        </div>
        <div className="flex items-center justify-between py-1">
          <span className="text-muted text-xs">Avg cost</span>
          <span className="text-fg font-mono text-sm tabular-nums">
            ${formatCents(avgCostCents)}
          </span>
        </div>
        <div className="flex items-center justify-between py-1">
          <span className="text-muted text-xs">Market value</span>
          <span className="text-fg font-mono text-sm tabular-nums">
            {valuation ? `$${formatCents(valuation.marketValueCents)}` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between py-1">
          <span className="text-muted text-xs">Unrealized P&amp;L</span>
          {valuation ? (
            <Delta
              cents={valuation.unrealizedPnlCents}
              percent={valuation.unrealizedPnlPercent}
              showCurrency
            />
          ) : (
            <span className="text-subtle font-mono text-sm tabular-nums">—</span>
          )}
        </div>
      </div>
    </section>
  );
}
