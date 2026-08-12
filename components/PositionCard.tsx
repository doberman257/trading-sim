import Link from "next/link";
import { Delta } from "./Delta";
import { Sparkline } from "./Sparkline";
import { formatCents } from "@/lib/trading/money";
import type { PositionRowProps } from "./PositionRow";

// The mobile counterpart of PositionRow (a <tr>) - see the trading-ui-design
// skill's Responsive tables pattern for why this is a separate component
// rather than the same markup toggled by CSS: a <tr> outside a <table> is
// invalid HTML and gets silently dropped by the browser. Also why this one,
// unlike PositionRow, links the whole card rather than just the symbol -
// same reasoning as PopularStockCard: a <tr> can't validly be wrapped in
// its own <a>, but a <div>-shaped card can, so the whole card is the tap
// target here.
export function PositionCard({
  symbol,
  quantity,
  avgCostCents,
  currentPriceCents,
  marketValueCents,
  unrealizedPnlCents,
  unrealizedPnlPercent: percent,
  isStale = false,
  sparklineCloses,
}: PositionRowProps) {
  const priceUnavailable =
    currentPriceCents === null ||
    marketValueCents === null ||
    unrealizedPnlCents === null ||
    percent === null;

  return (
    <Link
      href={`/stock/${symbol}`}
      className="border-default bg-elevated hover:bg-selected block rounded-md border p-3 transition-colors"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-fg font-medium">{symbol}</span>
        {priceUnavailable ? (
          <span className="text-subtle text-xs">price unavailable</span>
        ) : (
          isStale && <span className="text-warn text-xs">stale</span>
        )}
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-muted text-xs">Qty</span>
        <span className="text-fg font-mono text-sm tabular-nums">{quantity}</span>
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-muted text-xs">Avg cost</span>
        <span className="text-fg font-mono text-sm tabular-nums">${formatCents(avgCostCents)}</span>
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-muted text-xs">Price</span>
        <span className={`text-fg font-mono text-sm tabular-nums ${isStale ? "opacity-60" : ""}`}>
          {currentPriceCents !== null ? `$${formatCents(currentPriceCents)}` : "—"}
        </span>
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-muted text-xs">Market value</span>
        <span className={`text-fg font-mono text-sm tabular-nums ${isStale ? "opacity-60" : ""}`}>
          {marketValueCents !== null ? `$${formatCents(marketValueCents)}` : "—"}
        </span>
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-muted text-xs">Unrealized P&amp;L</span>
        {unrealizedPnlCents !== null && percent !== null ? (
          <Delta cents={unrealizedPnlCents} percent={percent} showCurrency />
        ) : (
          <span className="text-subtle font-mono text-sm tabular-nums">—</span>
        )}
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-muted text-xs">30d trend</span>
        <Sparkline closesCents={sparklineCloses} />
      </div>
    </Link>
  );
}
