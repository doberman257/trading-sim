import { formatOrderTimestamp } from "./RecentOrdersPanel";
import { formatCents } from "@/lib/trading/money";
import type { Side } from "@/lib/trading/types";

export type StockOrderHistoryItem = {
  id: string;
  side: Side;
  quantity: number;
  filledPriceCents: bigint;
  filledAt: Date;
};

export type StockOrderHistoryProps = {
  fills: StockOrderHistoryItem[];
};

// No Status column, unlike RecentOrdersPanel: every row here is already a
// fill (see getFilledOrdersForSymbol) - a rejected or still-pending order
// has nothing to show on a per-symbol history list. No Symbol column either
// - it's implicitly this page's own symbol on every row.
export function StockOrderHistory({ fills }: StockOrderHistoryProps) {
  const now = new Date();

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Order history</h2>
      </header>
      <div className="p-4">
        {fills.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">
            No orders filled for this symbol yet.
          </p>
        ) : (
          <>
            {/* Table at lg+, stacked cards below - see the trading-ui-design
                skill's Responsive tables pattern. */}
            <table className="hidden w-full text-sm lg:table">
              <thead>
                <tr className="border-default border-b">
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-left text-xs font-normal tracking-wide uppercase"
                  >
                    Side
                  </th>
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase"
                  >
                    Qty
                  </th>
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase"
                  >
                    Fill price
                  </th>
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-left text-xs font-normal tracking-wide uppercase"
                  >
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {fills.map((fill) => (
                  <tr
                    key={fill.id}
                    className="border-default/50 hover:bg-elevated border-b transition-colors"
                  >
                    {/* Not gain/loss colored: buy/sell side isn't itself a
                        financial direction - see RecentOrdersPanel's own note. */}
                    <td className="text-fg px-3 py-2.5 capitalize">{fill.side}</td>
                    <td className="text-fg px-3 py-2.5 text-right font-mono tabular-nums">
                      {fill.quantity}
                    </td>
                    <td className="text-fg px-3 py-2.5 text-right font-mono tabular-nums">
                      ${formatCents(fill.filledPriceCents)}
                    </td>
                    <td className="text-muted px-3 py-2.5 text-xs">
                      {formatOrderTimestamp(fill.filledAt, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex flex-col gap-2 lg:hidden">
              {fills.map((fill) => (
                <div key={fill.id} className="border-default bg-elevated rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-fg font-medium capitalize">{fill.side}</span>
                    <span className="text-muted text-xs">
                      {formatOrderTimestamp(fill.filledAt, now)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-muted text-xs">Qty</span>
                    <span className="text-fg font-mono text-sm tabular-nums">{fill.quantity}</span>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-muted text-xs">Fill price</span>
                    <span className="text-fg font-mono text-sm tabular-nums">
                      ${formatCents(fill.filledPriceCents)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
