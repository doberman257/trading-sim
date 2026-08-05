import { OrderStatusBadge } from "./OrderStatusBadge";
import type { PortfolioOrder } from "@/lib/db/portfolio";
import { formatCents } from "@/lib/trading/money";

export type RecentOrdersPanelProps = {
  orders: PortfolioOrder[];
};

// Display formatting only, not a trading rule - exported (not just used
// internally) so the exact text is unit-testable without a DOM/render setup,
// same reasoning as MarketStatusBanner's message functions. Takes `now` as
// an explicit argument rather than defaulting to `new Date()` internally,
// matching lib/trading/market-hours.ts's own convention - callers pass a
// real Date, tests pass an explicit one.
//
// Relative for recent orders, short absolute for older ones - a bare
// "Aug 5, 3:32 PM" wraps onto three lines in a narrow table column; "3m ago"
// never wraps at any reasonable width.
export function formatOrderTimestamp(date: Date, now: Date): string {
  const diffMinutes = Math.floor((now.getTime() - date.getTime()) / 60_000);

  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(date);
}

export function RecentOrdersPanel({ orders }: RecentOrdersPanelProps) {
  const now = new Date();

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Recent orders</h2>
      </header>
      <div className="p-4">
        {orders.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">No orders placed yet.</p>
        ) : (
          <>
            {/* Table at lg+ - see the trading-ui-design skill's Responsive
                tables pattern for why this isn't just one markup shown/hidden
                by CSS: a <tr> outside a <table> is invalid HTML and gets
                silently dropped, so the card layout below is a genuinely
                separate structure, not a CSS trick on the same one. */}
            <table className="hidden w-full text-sm lg:table">
              <thead>
                <tr className="border-default border-b">
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-left text-xs font-normal tracking-wide uppercase"
                  >
                    Symbol
                  </th>
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
                    <td className="text-fg px-3 py-2.5 font-medium">{order.symbol}</td>
                    {/* Not gain/loss colored: buy/sell side isn't itself a financial
                        direction - that pairing is reserved for the order ticket's
                        buy/sell toggle (see trading-ui-design skill). */}
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

            {/* Stacked cards below lg - see the skill's Responsive tables pattern. */}
            <div className="flex flex-col gap-2 lg:hidden">
              {orders.map((order) => (
                <div key={order.id} className="border-default bg-elevated rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-fg font-medium">{order.symbol}</span>
                    <OrderStatusBadge status={order.status} />
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-muted text-xs">Side</span>
                    <span className="text-fg text-sm capitalize">{order.side}</span>
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
