import Link from "next/link";
import { formatCents } from "@/lib/trading/money";

export type PopularStockRowProps = {
  symbol: string;
  name: string;
  // null together when no live quote was available for this symbol - same
  // "null means unknown, never zero" convention as PositionRow.
  bidCents: bigint | null;
  askCents: bigint | null;
};

export function PopularStockRow({ symbol, name, bidCents, askCents }: PopularStockRowProps) {
  const priceUnavailable = bidCents === null || askCents === null;

  return (
    <tr className="border-default/50 hover:bg-elevated border-b transition-colors">
      <td className="px-3 py-2.5">
        <Link href={`/stock/${symbol}`} className="text-fg font-medium hover:underline">
          {symbol}
        </Link>
      </td>
      <td className="text-muted px-3 py-2.5">{name}</td>
      <td className="px-3 py-2.5 text-right font-mono text-sm tabular-nums">
        {priceUnavailable ? (
          <span className="text-subtle">—</span>
        ) : (
          <span className="text-fg">${formatCents(bidCents)}</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-sm tabular-nums">
        {priceUnavailable ? (
          <span className="text-subtle">—</span>
        ) : (
          <span className="text-fg">${formatCents(askCents)}</span>
        )}
      </td>
    </tr>
  );
}
