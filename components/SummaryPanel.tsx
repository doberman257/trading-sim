import { Delta } from "./Delta";
import { formatCents } from "@/lib/trading/money";
import { describeMissingQuote } from "@/lib/trading/quote";

export type SummaryPanelProps = {
  cashCents: bigint;
  totalEquityCents: bigint;
  totalUnrealizedPnlCents: bigint;
  missingQuoteSymbols: string[];
  /** True when the market is closed - see PositionsPanel's own isStale prop. */
  isStale: boolean;
};

export function SummaryPanel({
  cashCents,
  totalEquityCents,
  totalUnrealizedPnlCents,
  missingQuoteSymbols,
  isStale,
}: SummaryPanelProps) {
  const isPartial = missingQuoteSymbols.length > 0;

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Summary</h2>
      </header>
      <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
        <div>
          <div className="text-muted text-xs">Total equity</div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <div className="text-fg font-mono text-2xl tabular-nums">
              ${formatCents(totalEquityCents)}
            </div>
            {isPartial && (
              <span className="text-warn text-xs font-medium">
                + {missingQuoteSymbols.join(", ")} unpriced
              </span>
            )}
          </div>
          {/* Not worded as an error - a missing quote while the market is
              closed is this app's expected, common case (no quote cache,
              see CLAUDE.md), not something broken. describeMissingQuote
              (lib/trading/quote.ts) is the one place this wording lives,
              shared with PositionRow/PositionCard so all three read
              identically. */}
          {isPartial && (
            <div className="text-muted mt-1 text-xs">
              {describeMissingQuote(missingQuoteSymbols, !isStale)}
            </div>
          )}
        </div>
        <div>
          <div className="text-muted text-xs">Cash</div>
          <div className="text-fg font-mono text-2xl tabular-nums">${formatCents(cashCents)}</div>
        </div>
        <div>
          <div className="text-muted text-xs">Unrealized P&amp;L</div>
          <div className="text-2xl">
            <Delta cents={totalUnrealizedPnlCents} showCurrency />
          </div>
        </div>
      </div>
    </section>
  );
}
