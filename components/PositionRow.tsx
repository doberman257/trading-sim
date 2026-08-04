import { formatCents, multiply } from "@/lib/trading/money";

export type PositionRowProps = {
  symbol: string;
  quantity: number;
  avgCostCents: bigint;
  currentPriceCents: bigint;
  /** True when the market is closed or the quote is older than the staleness threshold. */
  isStale?: boolean;
};

export function PositionRow({
  symbol,
  quantity,
  avgCostCents,
  currentPriceCents,
  isStale = false,
}: PositionRowProps) {
  const marketValueCents = multiply(currentPriceCents, quantity);
  const deltaCents = currentPriceCents - avgCostCents;
  const unrealizedPnlCents = multiply(deltaCents, quantity);
  const percent = avgCostCents === 0n ? 0 : (Number(deltaCents) / Number(avgCostCents)) * 100;

  const up = unrealizedPnlCents >= 0n;
  const flat = unrealizedPnlCents === 0n;

  return (
    <tr className="border-default/50 hover:bg-elevated border-b transition-colors">
      <td className="text-fg px-3 py-2.5 font-medium">
        {symbol}
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
        {formatCents(avgCostCents)}
      </td>
      <td
        className={`text-fg px-3 py-2.5 text-right font-mono text-sm tabular-nums ${
          isStale ? "opacity-60" : ""
        }`}
      >
        {formatCents(currentPriceCents)}
      </td>
      <td
        className={`text-fg px-3 py-2.5 text-right font-mono text-sm tabular-nums ${
          isStale ? "opacity-60" : ""
        }`}
      >
        {formatCents(marketValueCents)}
      </td>
      <td className={`px-3 py-2.5 text-right ${isStale ? "opacity-60" : ""}`}>
        <span
          className={`font-mono text-sm tabular-nums ${
            flat ? "text-muted" : up ? "text-gain" : "text-loss"
          }`}
          aria-label={`unrealized P&L ${up ? "up" : "down"} ${formatCents(
            unrealizedPnlCents < 0n ? -unrealizedPnlCents : unrealizedPnlCents,
          )}, ${Math.abs(percent).toFixed(1)} percent`}
        >
          {!flat && <span aria-hidden>{up ? "▲" : "▼"}</span>} {!flat && (up ? "+" : "−")}
          {formatCents(unrealizedPnlCents < 0n ? -unrealizedPnlCents : unrealizedPnlCents)}
          {!flat && (
            <>
              {" "}
              ({up ? "+" : "−"}
              {Math.abs(percent).toFixed(1)}%)
            </>
          )}
        </span>
      </td>
    </tr>
  );
}
