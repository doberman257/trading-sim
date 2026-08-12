import Link from "next/link";
import { Delta } from "./Delta";
import { Sparkline } from "./Sparkline";
import { formatCents } from "@/lib/trading/money";

export type PositionRowProps = {
  symbol: string;
  quantity: number;
  avgCostCents: bigint;
  // All four below come pre-computed from calculatePortfolio (lib/trading/portfolio.ts)
  // - this component never does money math, only display. They are null
  // together when no quote was available for this symbol; that must render
  // as visibly distinct from a real zero, never silently the same.
  currentPriceCents: bigint | null;
  marketValueCents: bigint | null;
  unrealizedPnlCents: bigint | null;
  unrealizedPnlPercent: number | null;
  /** True when the market is closed or the quote is older than the staleness threshold. */
  isStale?: boolean;
  /** Daily closes, oldest first, for the trend sparkline. Empty when unavailable. */
  sparklineCloses: readonly bigint[];
};

export function PositionRow({
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
  if (
    currentPriceCents === null ||
    marketValueCents === null ||
    unrealizedPnlCents === null ||
    percent === null
  ) {
    return (
      <tr className="border-default/50 hover:bg-elevated border-b transition-colors">
        <td className="text-fg px-3 py-2.5 font-medium">
          <Link href={`/stock/${symbol}`} className="hover:underline">
            {symbol}
          </Link>
          <span
            className="text-subtle ml-2 inline-flex items-center gap-1 text-xs font-normal"
            title="No quote is currently available for this symbol"
          >
            <span aria-hidden>?</span>
            price unavailable
          </span>
        </td>
        <td className="text-fg px-3 py-2.5 text-right font-mono text-sm tabular-nums">
          {quantity}
        </td>
        <td className="text-fg px-3 py-2.5 text-right font-mono text-sm tabular-nums">
          ${formatCents(avgCostCents)}
        </td>
        <td className="text-subtle px-3 py-2.5 text-right font-mono text-sm tabular-nums">—</td>
        <td className="text-subtle px-3 py-2.5 text-right font-mono text-sm tabular-nums">—</td>
        <td className="text-subtle px-3 py-2.5 text-right font-mono text-sm tabular-nums">—</td>
        <td className="px-3 py-2.5">
          <Sparkline closesCents={sparklineCloses} />
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-default/50 hover:bg-elevated border-b transition-colors">
      <td className="text-fg px-3 py-2.5 font-medium">
        <Link href={`/stock/${symbol}`} className="hover:underline">
          {symbol}
        </Link>
        {isStale && (
          <span
            className="text-warn ml-2 inline-flex items-center gap-1 text-xs font-normal"
            title="Market closed - price shown is from the last close"
          >
            <span aria-hidden>◷</span>
            stale
          </span>
        )}
      </td>
      <td className="text-fg px-3 py-2.5 text-right font-mono text-sm tabular-nums">{quantity}</td>
      <td className="text-fg px-3 py-2.5 text-right font-mono text-sm tabular-nums">
        ${formatCents(avgCostCents)}
      </td>
      <td
        className={`text-fg px-3 py-2.5 text-right font-mono text-sm tabular-nums ${
          isStale ? "opacity-60" : ""
        }`}
      >
        ${formatCents(currentPriceCents)}
      </td>
      <td
        className={`text-fg px-3 py-2.5 text-right font-mono text-sm tabular-nums ${
          isStale ? "opacity-60" : ""
        }`}
      >
        ${formatCents(marketValueCents)}
      </td>
      <td className={`px-3 py-2.5 text-right ${isStale ? "opacity-60" : ""}`}>
        <Delta cents={unrealizedPnlCents} percent={percent} showCurrency />
      </td>
      <td className="px-3 py-2.5">
        <Sparkline closesCents={sparklineCloses} />
      </td>
    </tr>
  );
}
