import { Delta } from "./Delta";
import { formatCents } from "@/lib/trading/money";

export type SummaryPanelProps = {
  cashCents: bigint;
  totalEquityCents: bigint;
  totalUnrealizedPnlCents: bigint;
  missingQuoteSymbols: string[];
};

export function SummaryPanel({
  cashCents,
  totalEquityCents,
  totalUnrealizedPnlCents,
  missingQuoteSymbols,
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
          <div className="text-fg font-mono text-2xl tabular-nums">
            ${formatCents(totalEquityCents)}
          </div>
          {isPartial && (
            <div className="text-warn mt-1 text-xs">
              Partial — price unavailable for {missingQuoteSymbols.join(", ")}
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
