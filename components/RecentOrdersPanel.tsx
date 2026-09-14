"use client";

import { useMemo, useState } from "react";
import { OrderStatusBadge } from "./OrderStatusBadge";
import { Pagination } from "./Pagination";
import { SortDropdown, type SortDropdownOption } from "./SortDropdown";
import type { OrderStatus, PortfolioOrder } from "@/lib/db/portfolio";
import { DEFAULT_PAGE_SIZE, clampPage, getPageCount, paginate } from "@/lib/pagination";
import { formatCents } from "@/lib/trading/money";

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

// Both endpoints go through the SAME formatOrderTimestamp every other
// timestamp in this panel uses - no separate ad-hoc range format. Collapses
// to a single value instead of "X-X" when both ends format identically
// (a run that happened entirely within the same "3m ago" bucket, or on the
// same short absolute date) - "X-X" would read as a formatting bug, not a
// real range.
export function formatCollapsedOrderTimeRange(oldest: Date, newest: Date, now: Date): string {
  const oldestText = formatOrderTimestamp(oldest, now);
  const newestText = formatOrderTimestamp(newest, now);
  return oldestText === newestText ? oldestText : `${oldestText} – ${newestText}`;
}

// A short, human label for a raw RejectReason string - not
// components/orderMessages.ts's describeRejection, which needs order-
// ticket-specific context (available cash, held quantity) this panel
// doesn't carry, same "own function per real context" reasoning
// BotRunsPanel's cancelOutcomeMessage already documents for itself. This
// one just makes the stored value readable, nothing richer.
function rejectReasonLabel(reason: string): string {
  switch (reason) {
    case "market_closed":
      return "Market closed";
    case "stale_quote":
      return "Stale quote";
    case "no_quote":
      return "No live quote";
    case "insufficient_funds":
      return "Insufficient funds";
    case "insufficient_shares":
      return "Insufficient shares";
    case "invalid_quantity":
      return "Invalid quantity";
    case "invalid_limit_price":
      return "Invalid limit price";
    default:
      // A reason this panel doesn't recognize (a future addition to
      // RejectReason, or corrupt data) - shown as-is rather than hidden,
      // same "narrow via a real value, never silently swallow" discipline
      // as everywhere else in this app that reads a stored string back.
      return reason;
  }
}

export type OrderStatusFilter = "all" | OrderStatus;

export const ORDER_STATUS_FILTER_OPTIONS: readonly SortDropdownOption<OrderStatusFilter>[] = [
  { value: "all", label: "All" },
  { value: "filled", label: "Filled" },
  { value: "rejected", label: "Rejected" },
  { value: "pending", label: "Pending" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

export function filterOrdersByStatus(
  orders: PortfolioOrder[],
  filter: OrderStatusFilter,
): PortfolioOrder[] {
  if (filter === "all") return orders;
  return orders.filter((order) => order.status === filter);
}

export type RecentOrderSortKey = "newest" | "symbol" | "status";

export const RECENT_ORDER_SORT_OPTIONS: readonly SortDropdownOption<RecentOrderSortKey>[] = [
  { value: "newest", label: "Newest" },
  { value: "symbol", label: "Symbol" },
  { value: "status", label: "Status" },
];

// A client-side sort over the full, already-loaded order list (capped at 20
// by getPortfolio - see lib/db/portfolio.ts) - this panel has no server-side
// query of its own to re-order.
export function sortRecentOrders(
  orders: PortfolioOrder[],
  sortKey: RecentOrderSortKey,
): PortfolioOrder[] {
  const sorted = [...orders];
  switch (sortKey) {
    case "newest":
      sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      break;
    case "symbol":
      sorted.sort((a, b) => a.symbol.localeCompare(b.symbol));
      break;
    case "status":
      sorted.sort((a, b) => a.status.localeCompare(b.status));
      break;
    default: {
      const _exhaustive: never = sortKey;
      return _exhaustive;
    }
  }
  return sorted;
}

export type RecentOrderDisplayRow =
  | { kind: "order"; order: PortfolioOrder }
  | {
      kind: "collapsed-rejections";
      key: string;
      symbol: string;
      side: PortfolioOrder["side"];
      quantity: number;
      rejectReason: string | null;
      count: number;
      oldestCreatedAt: Date;
      newestCreatedAt: Date;
    };

// Merges a RUN of adjacent, identically-shaped REJECTED orders (same
// symbol + side + quantity + rejectReason) into one summary row -
// deliberately scoped to rejected orders only, never filled/pending/
// cancelled ones. A rejected order carries no unique outcome (no fill
// price, no distinct effect on the account) so a repeated identical
// failure really is fungible information; a filled order is a distinct
// real trade even if, by coincidence, its shape matches an adjacent one,
// and collapsing those would hide real history. This is exactly the
// CRWV/GOOGL incident this exists for - 23 repeated market_closed
// rejections for the same stuck exit attempt crowding every real fill off
// the panel - never a case of "these two trades happened to look similar."
//
// Adjacency is evaluated in whatever order the caller already sorted into
// - this is a pure display transform over an already-ordered list, with no
// opinion of its own about sort order. Under a non-"newest" sort, this can
// merge rejections from genuinely different days into one group if they
// end up adjacent and share the same shape - accepted, since a rejected
// order's own individual timestamp was never load-bearing information to
// begin with, only the range as a whole is.
//
// Runs over the FULL sorted/filtered order list, before it's sliced into
// pages by Pagination below - this is what makes a rejection run collapse
// into one correct count/range regardless of which page(s) its individual
// orders would otherwise land on.
export function collapseConsecutiveRejections(orders: PortfolioOrder[]): RecentOrderDisplayRow[] {
  const rows: RecentOrderDisplayRow[] = [];

  for (const order of orders) {
    const last = rows.at(-1);

    if (
      order.status === "rejected" &&
      last?.kind === "collapsed-rejections" &&
      last.symbol === order.symbol &&
      last.side === order.side &&
      last.quantity === order.quantity &&
      last.rejectReason === order.rejectReason
    ) {
      last.count += 1;
      if (order.createdAt.getTime() < last.oldestCreatedAt.getTime()) {
        last.oldestCreatedAt = order.createdAt;
      }
      if (order.createdAt.getTime() > last.newestCreatedAt.getTime()) {
        last.newestCreatedAt = order.createdAt;
      }
      continue;
    }

    if (
      order.status === "rejected" &&
      last?.kind === "order" &&
      last.order.status === "rejected" &&
      last.order.symbol === order.symbol &&
      last.order.side === order.side &&
      last.order.quantity === order.quantity &&
      last.order.rejectReason === order.rejectReason
    ) {
      // The previous row was still a lone rejected order - promote it into
      // a fresh group of 2 rather than requiring a run of 3+ before
      // collapsing kicks in.
      const previous = last.order;
      rows[rows.length - 1] = {
        kind: "collapsed-rejections",
        key: previous.id,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        rejectReason: order.rejectReason,
        count: 2,
        oldestCreatedAt:
          order.createdAt.getTime() < previous.createdAt.getTime()
            ? order.createdAt
            : previous.createdAt,
        newestCreatedAt:
          order.createdAt.getTime() > previous.createdAt.getTime()
            ? order.createdAt
            : previous.createdAt,
      };
      continue;
    }

    rows.push({ kind: "order", order });
  }

  return rows;
}

export function RecentOrdersPanel({ orders }: { orders: PortfolioOrder[] }) {
  const now = new Date();
  const [statusFilter, setStatusFilter] = useState<OrderStatusFilter>("all");
  const [sortKey, setSortKey] = useState<RecentOrderSortKey>("newest");
  const [page, setPage] = useState(1);

  const sortedFiltered = useMemo(() => {
    const sorted = sortRecentOrders(orders, sortKey);
    return filterOrdersByStatus(sorted, statusFilter);
  }, [orders, sortKey, statusFilter]);

  // Collapsed over the FULL sorted/filtered list, THEN paginated - see
  // collapseConsecutiveRejections's own comment on why that order matters.
  const displayRows = useMemo(
    () => collapseConsecutiveRejections(sortedFiltered),
    [sortedFiltered],
  );
  const pageCount = getPageCount(displayRows.length, DEFAULT_PAGE_SIZE);
  const pageRows = paginate(displayRows, page, DEFAULT_PAGE_SIZE);

  // Changing sort or filter jumps back to page 1 - a page number from the
  // previous ordering doesn't mean anything under a new one.
  function handleSortChange(next: RecentOrderSortKey): void {
    setSortKey(next);
    setPage(1);
  }

  function handleFilterChange(next: OrderStatusFilter): void {
    setStatusFilter(next);
    setPage(1);
  }

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Recent orders</h2>
        {orders.length > 0 && (
          <div className="flex items-center gap-3">
            <SortDropdown
              label="Filter"
              value={statusFilter}
              options={ORDER_STATUS_FILTER_OPTIONS}
              onChange={handleFilterChange}
            />
            <SortDropdown
              label="Sort"
              value={sortKey}
              options={RECENT_ORDER_SORT_OPTIONS}
              onChange={handleSortChange}
            />
          </div>
        )}
      </header>
      <div className="p-4">
        {displayRows.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">
            {orders.length === 0 ? "No orders placed yet." : "No orders match this filter."}
          </p>
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
                {pageRows.map((row) =>
                  row.kind === "order" ? (
                    <tr
                      key={row.order.id}
                      className="border-default/50 hover:bg-elevated border-b transition-colors"
                    >
                      <td className="text-fg px-3 py-2.5 font-medium">{row.order.symbol}</td>
                      {/* Not gain/loss colored: buy/sell side isn't itself a financial
                          direction - that pairing is reserved for the order ticket's
                          buy/sell toggle (see trading-ui-design skill). */}
                      <td className="text-fg px-3 py-2.5 capitalize">{row.order.side}</td>
                      <td className="text-fg px-3 py-2.5 text-right font-mono tabular-nums">
                        {row.order.quantity}
                      </td>
                      <td className="px-3 py-2.5">
                        <OrderStatusBadge status={row.order.status} />
                        {row.order.status === "rejected" && row.order.rejectReason && (
                          <div className="text-subtle mt-0.5 text-xs">
                            {rejectReasonLabel(row.order.rejectReason)}
                          </div>
                        )}
                      </td>
                      <td className="text-fg px-3 py-2.5 text-right font-mono tabular-nums">
                        {row.order.filledPriceCents !== null
                          ? `$${formatCents(row.order.filledPriceCents)}`
                          : "—"}
                      </td>
                      <td className="text-muted px-3 py-2.5 text-xs">
                        {formatOrderTimestamp(row.order.createdAt, now)}
                      </td>
                    </tr>
                  ) : (
                    <tr
                      key={row.key}
                      className="border-default/50 hover:bg-elevated border-b transition-colors"
                    >
                      <td className="text-fg px-3 py-2.5 font-medium">{row.symbol}</td>
                      <td className="text-fg px-3 py-2.5 capitalize">{row.side}</td>
                      <td className="text-fg px-3 py-2.5 text-right font-mono tabular-nums">
                        {row.quantity}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <OrderStatusBadge status="rejected" />
                          <span className="text-subtle text-xs">&times;{row.count}</span>
                        </div>
                        {row.rejectReason && (
                          <div className="text-subtle mt-0.5 text-xs">
                            {rejectReasonLabel(row.rejectReason)}
                          </div>
                        )}
                      </td>
                      <td className="text-fg px-3 py-2.5 text-right font-mono tabular-nums">—</td>
                      <td className="text-muted px-3 py-2.5 text-xs">
                        {formatCollapsedOrderTimeRange(
                          row.oldestCreatedAt,
                          row.newestCreatedAt,
                          now,
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>

            {/* Stacked cards below lg - see the skill's Responsive tables pattern. */}
            <div className="flex flex-col gap-2 lg:hidden">
              {pageRows.map((row) =>
                row.kind === "order" ? (
                  <div
                    key={row.order.id}
                    className="border-default bg-elevated rounded-md border p-3"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-fg font-medium">{row.order.symbol}</span>
                      <OrderStatusBadge status={row.order.status} />
                    </div>
                    {row.order.status === "rejected" && row.order.rejectReason && (
                      <div className="text-subtle -mt-1 mb-2 text-right text-xs">
                        {rejectReasonLabel(row.order.rejectReason)}
                      </div>
                    )}
                    <div className="flex items-center justify-between py-1">
                      <span className="text-muted text-xs">Side</span>
                      <span className="text-fg text-sm capitalize">{row.order.side}</span>
                    </div>
                    <div className="flex items-center justify-between py-1">
                      <span className="text-muted text-xs">Qty</span>
                      <span className="text-fg font-mono text-sm tabular-nums">
                        {row.order.quantity}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-1">
                      <span className="text-muted text-xs">Fill price</span>
                      <span className="text-fg font-mono text-sm tabular-nums">
                        {row.order.filledPriceCents !== null
                          ? `$${formatCents(row.order.filledPriceCents)}`
                          : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-1">
                      <span className="text-muted text-xs">Time</span>
                      <span className="text-muted text-xs">
                        {formatOrderTimestamp(row.order.createdAt, now)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div key={row.key} className="border-default bg-elevated rounded-md border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-fg font-medium">{row.symbol}</span>
                      <div className="flex items-center gap-1.5">
                        <OrderStatusBadge status="rejected" />
                        <span className="text-subtle text-xs">&times;{row.count}</span>
                      </div>
                    </div>
                    {row.rejectReason && (
                      <div className="text-subtle -mt-1 mb-2 text-right text-xs">
                        {rejectReasonLabel(row.rejectReason)}
                      </div>
                    )}
                    <div className="flex items-center justify-between py-1">
                      <span className="text-muted text-xs">Side</span>
                      <span className="text-fg text-sm capitalize">{row.side}</span>
                    </div>
                    <div className="flex items-center justify-between py-1">
                      <span className="text-muted text-xs">Qty</span>
                      <span className="text-fg font-mono text-sm tabular-nums">{row.quantity}</span>
                    </div>
                    <div className="flex items-center justify-between py-1">
                      <span className="text-muted text-xs">Time</span>
                      <span className="text-muted text-xs">
                        {formatCollapsedOrderTimeRange(
                          row.oldestCreatedAt,
                          row.newestCreatedAt,
                          now,
                        )}
                      </span>
                    </div>
                  </div>
                ),
              )}
            </div>
            <Pagination
              page={clampPage(page, pageCount)}
              pageCount={pageCount}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
    </section>
  );
}
