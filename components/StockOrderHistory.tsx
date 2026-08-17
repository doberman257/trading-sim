import { OrderStatusBadge } from "./OrderStatusBadge";
import { formatOrderTimestamp } from "./RecentOrdersPanel";
import type { OrderStatus } from "@/lib/db/portfolio";
import { formatCents } from "@/lib/trading/money";
import type { Side } from "@/lib/trading/types";

export type StockOrderHistoryItem = {
  id: string;
  side: Side;
  quantity: number;
  status: OrderStatus;
  filledPriceCents: bigint | null;
  createdAt: Date;
};

export type StockOrderHistoryProps = {
  orders: StockOrderHistoryItem[];
};

// Every order for this symbol regardless of status (pending/filled/
// cancelled/rejected/expired), not just fills - a tab literally named
// "Orders" should show a cancellation for this symbol, not just make the
// user go find it in the dashboard's global feed. Time uses createdAt for
// every row, not filledAt (null for anything but a fill) - matching
// RecentOrdersPanel's own convention. No Symbol column - it's implicitly
// this page's own symbol on every row.
export function StockOrderHistory({ orders }: StockOrderHistoryProps) {
  const now = new Date();

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Order history</h2>
      </header>
      <div className="p-4">
        {orders.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">
            No orders placed for this symbol yet.
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
                    className="text-muted px-3 py-2 text-left text-xs font-normal tracking-wide uppercase"
                  >
                    Status
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
                {orders.map((order) => (
                  <tr
                    key={order.id}
                    className="border-default/50 hover:bg-elevated border-b transition-colors"
                  >
                    {/* Not gain/loss colored: buy/sell side isn't itself a
                        financial direction - see RecentOrdersPanel's own note. */}
                    <td className="text-fg px-3 py-2.5 capitalize">{order.side}</td>
                    <td className="text-fg px-3 py-2.5 text-right font-mono tabular-nums">
                      {order.quantity}
                    </td>
                    <td className="px-3 py-2.5">
                      <OrderStatusBadge status={order.status} />
                    </td>
                    <td className="text-fg px-3 py-2.5 text-right font-mono tabular-nums">
                      {order.filledPriceCents !== null
                        ? `$${formatCents(order.filledPriceCents)}`
                        : "—"}
                    </td>
                    <td className="text-muted px-3 py-2.5 text-xs">
                      {formatOrderTimestamp(order.createdAt, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex flex-col gap-2 lg:hidden">
              {orders.map((order) => (
                <div key={order.id} className="border-default bg-elevated rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-fg font-medium capitalize">{order.side}</span>
                    <OrderStatusBadge status={order.status} />
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-muted text-xs">Qty</span>
                    <span className="text-fg font-mono text-sm tabular-nums">{order.quantity}</span>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-muted text-xs">Fill price</span>
                    <span className="text-fg font-mono text-sm tabular-nums">
                      {order.filledPriceCents !== null
                        ? `$${formatCents(order.filledPriceCents)}`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-muted text-xs">Time</span>
                    <span className="text-muted text-xs">
                      {formatOrderTimestamp(order.createdAt, now)}
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
