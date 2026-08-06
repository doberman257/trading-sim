import Link from "next/link";
import { formatCents } from "@/lib/trading/money";
import type { PopularStockRowProps } from "./PopularStockRow";

// The mobile counterpart of PopularStockRow (a <tr>) - see the
// trading-ui-design skill's Responsive tables pattern for why this is a
// separate component rather than the same markup toggled by CSS. Unlike a
// <tr>, a <div> can validly be wrapped in the row's own <Link>, so the whole
// card is the tap target here rather than just the symbol.
export function PopularStockCard({ symbol, name, bidCents, askCents }: PopularStockRowProps) {
  const priceUnavailable = bidCents === null || askCents === null;

  return (
    <Link
      href={`/stock/${symbol}`}
      className="border-default bg-elevated hover:bg-selected block rounded-md border p-3 transition-colors"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-fg font-medium">{symbol}</span>
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
    </Link>
  );
}
