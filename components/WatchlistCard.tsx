import Link from "next/link";
import { Sparkline } from "./Sparkline";
import { WatchlistStar } from "./WatchlistStar";
import { formatCents } from "@/lib/trading/money";
import type { WatchlistRowProps } from "./WatchlistRow";

// The mobile counterpart of WatchlistRow (a <tr>) - see the
// trading-ui-design skill's Responsive tables pattern.
export function WatchlistCard({
  symbol,
  name,
  bidCents,
  askCents,
  sparklineCloses,
}: WatchlistRowProps) {
  const priceUnavailable = bidCents === null || askCents === null;

  return (
    <div className="border-default bg-elevated rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <WatchlistStar symbol={symbol} initialWatched />
          <Link href={`/stock/${symbol}`} className="text-fg font-medium hover:underline">
            {symbol}
          </Link>
        </div>
        <span className="text-muted truncate text-xs">{name}</span>
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-muted text-xs">Bid</span>
        <span className="text-fg font-mono text-sm tabular-nums">
          {priceUnavailable ? "—" : `$${formatCents(bidCents)}`}
        </span>
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-muted text-xs">Ask</span>
        <span className="text-fg font-mono text-sm tabular-nums">
          {priceUnavailable ? "—" : `$${formatCents(askCents)}`}
        </span>
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-muted text-xs">30d trend</span>
        <Sparkline closesCents={sparklineCloses} />
      </div>
    </div>
  );
}
