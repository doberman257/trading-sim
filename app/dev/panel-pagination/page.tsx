import { notFound } from "next/navigation";
import { BotRunsPanel, type BotRunItem } from "@/components/BotRunsPanel";
import { RecentOrdersPanel } from "@/components/RecentOrdersPanel";
import type { PortfolioOrder } from "@/lib/db/portfolio";
import {
  BREAKOUT_52WK_HIGH_V1_ID,
  BREAKOUT_52WK_HIGH_V1_PARAMS,
  GOLDEN_CROSS_V1_ID,
  GOLDEN_CROSS_V1_PARAMS,
  RSI_PULLBACK_UPTREND_V2_ID,
  RSI_PULLBACK_UPTREND_V2_PARAMS,
} from "@/lib/trading/bot-rule";
import { toCents } from "@/lib/trading/money";

// A fixed "now" so every relative timestamp in this preview
// (formatOrderTimestamp/formatCollapsedOrderTimeRange) renders
// deterministically across reloads, instead of drifting with the real
// clock.
const NOW = new Date("2026-08-28T08:00:00Z");
function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000);
}

let nextRunId = 0;
function runId(): string {
  nextRunId += 1;
  return `preview-run-${nextRunId}`;
}

function strategyForIndex(i: number): { ruleId: string; ruleParams: unknown } {
  switch (i % 3) {
    case 0:
      return { ruleId: RSI_PULLBACK_UPTREND_V2_ID, ruleParams: RSI_PULLBACK_UPTREND_V2_PARAMS };
    case 1:
      return { ruleId: GOLDEN_CROSS_V1_ID, ruleParams: GOLDEN_CROSS_V1_PARAMS };
    default:
      return { ruleId: BREAKOUT_52WK_HIGH_V1_ID, ruleParams: BREAKOUT_52WK_HIGH_V1_PARAMS };
  }
}

// 13 runs - deliberately past DEFAULT_PAGE_SIZE (10, lib/pagination.ts) so
// the Pagination control actually renders a second page here, not just the
// single-page "nothing to click" case.
const runs: BotRunItem[] = Array.from({ length: 13 }, (_, i) => {
  const { ruleId, ruleParams } = strategyForIndex(i);
  const closed = i % 3 !== 0;
  return {
    id: runId(),
    status: closed ? "closed_target" : "holding",
    ruleId,
    ruleParams,
    capitalCents: toCents("1000.00").toString(),
    selectedSymbol: ["GOOGL", "MSFT", "TSLA", "NVDA", "AMD"][i % 5] ?? "AAPL",
    entryTotalCents: toCents("980.00").toString(),
    entryQuantity: 4,
    realizedPnlCents: closed
      ? (i % 2 === 0 ? toCents("42.00") : -toCents("18.50")).toString()
      : null,
    createdAt: hoursAgo(i * 3).toISOString(),
    closedAt: closed ? hoursAgo(i).toISOString() : null,
  };
});

function order(partial: {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  status: PortfolioOrder["status"];
  filledPriceCents?: string;
  rejectReason?: string;
  createdAt: Date;
}): PortfolioOrder {
  return {
    id: partial.id,
    symbol: partial.symbol,
    side: partial.side,
    quantity: partial.quantity,
    status: partial.status,
    filledPriceCents: partial.filledPriceCents ? toCents(partial.filledPriceCents) : null,
    rejectReason: partial.rejectReason ?? null,
    createdAt: partial.createdAt,
    filledAt: partial.status === "filled" ? partial.createdAt : null,
  };
}

// Modeled directly on the real GOOGL/CRWV production incident (see
// STATE.md) - a repeated market_closed rejection burst for one stuck exit
// attempt. Unlike the old "Load more" version of this preview, the whole
// burst is loaded up front here - collapseConsecutiveRejections runs over
// the FULL list before Pagination slices it into pages, so the real ×7
// group renders correctly as one row regardless of which page its
// individual orders land on.
const orders: PortfolioOrder[] = [
  order({
    id: "o1",
    symbol: "GOOGL",
    side: "sell",
    quantity: 73,
    status: "rejected",
    rejectReason: "market_closed",
    createdAt: hoursAgo(0.2),
  }),
  order({
    id: "o2",
    symbol: "CRWV",
    side: "sell",
    quantity: 55,
    status: "rejected",
    rejectReason: "market_closed",
    createdAt: hoursAgo(0.3),
  }),
  order({
    id: "o3",
    symbol: "XYZ",
    side: "sell",
    quantity: 294,
    status: "pending",
    createdAt: hoursAgo(13.7),
  }),
  order({
    id: "o4",
    symbol: "XYZ",
    side: "buy",
    quantity: 294,
    status: "filled",
    filledPriceCents: "84.94",
    createdAt: hoursAgo(13.7),
  }),
  order({
    id: "o5",
    symbol: "GOOGL",
    side: "sell",
    quantity: 73,
    status: "cancelled",
    createdAt: hoursAgo(14.0),
  }),
  order({
    id: "o6",
    symbol: "GOOGL",
    side: "buy",
    quantity: 73,
    status: "filled",
    filledPriceCents: "340.69",
    createdAt: hoursAgo(14.0),
  }),
  order({
    id: "o7",
    symbol: "CRWV",
    side: "sell",
    quantity: 55,
    status: "rejected",
    rejectReason: "market_closed",
    createdAt: hoursAgo(15.5),
  }),
  order({
    id: "o8",
    symbol: "CRWV",
    side: "sell",
    quantity: 55,
    status: "rejected",
    rejectReason: "market_closed",
    createdAt: hoursAgo(16.3),
  }),
  order({
    id: "o9",
    symbol: "CRWV",
    side: "sell",
    quantity: 55,
    status: "rejected",
    rejectReason: "market_closed",
    createdAt: hoursAgo(17.1),
  }),
  order({
    id: "o10",
    symbol: "CRWV",
    side: "sell",
    quantity: 55,
    status: "rejected",
    rejectReason: "market_closed",
    createdAt: hoursAgo(17.9),
  }),
  order({
    id: "o11",
    symbol: "CRWV",
    side: "sell",
    quantity: 55,
    status: "rejected",
    rejectReason: "market_closed",
    createdAt: hoursAgo(18.7),
  }),
  order({
    id: "o12",
    symbol: "CRWV",
    side: "sell",
    quantity: 55,
    status: "rejected",
    rejectReason: "market_closed",
    createdAt: hoursAgo(19.5),
  }),
  order({
    id: "o13",
    symbol: "CRWV",
    side: "sell",
    quantity: 55,
    status: "rejected",
    rejectReason: "market_closed",
    createdAt: hoursAgo(20.3),
  }),
  order({
    id: "o14",
    symbol: "BMY",
    side: "buy",
    quantity: 40,
    status: "filled",
    filledPriceCents: "62.10",
    createdAt: hoursAgo(48),
  }),
  order({
    id: "o15",
    symbol: "KO",
    side: "buy",
    quantity: 25,
    status: "filled",
    filledPriceCents: "71.35",
    createdAt: hoursAgo(50),
  }),
  order({
    id: "o16",
    symbol: "FCX",
    side: "sell",
    quantity: 30,
    status: "filled",
    filledPriceCents: "44.80",
    createdAt: hoursAgo(52),
  }),
  // Two more plain fills, deliberately past what the CRWV collapse above
  // leaves room for: the 7-order rejection run collapses to 1 display row,
  // so 16 raw orders alone would land at exactly 10 display rows (16 - 7 +
  // 1) - precisely DEFAULT_PAGE_SIZE, which would hide the Pagination
  // control entirely. These two push it to 12, past one page for real.
  order({
    id: "o17",
    symbol: "AAPL",
    side: "buy",
    quantity: 15,
    status: "filled",
    filledPriceCents: "195.20",
    createdAt: hoursAgo(54),
  }),
  order({
    id: "o18",
    symbol: "JPM",
    side: "sell",
    quantity: 20,
    status: "filled",
    filledPriceCents: "210.05",
    createdAt: hoursAgo(56),
  }),
];

// Design preview only - meaningless once deployed. Same NODE_ENV gate as
// /dev/position-row and /dev/bot-runs-panel. A plain Server Component - both
// panels manage their own page/sort/filter state internally now, so unlike
// the old "Load more" version of this preview, this page has no
// interactivity of its own to justify a Client Component.
export default function PanelPaginationPreviewPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }

  return (
    <main className="bg-base min-h-screen p-6">
      <p className="text-subtle mb-4 max-w-3xl text-xs leading-relaxed">
        Design preview only — not part of the dashboard. Demonstrates the numbered{" "}
        <code className="text-muted">Pagination</code> control (7 rows per page,{" "}
        <code className="text-muted">DEFAULT_PAGE_SIZE</code> in{" "}
        <code className="text-muted">lib/pagination.ts</code>) on both{" "}
        <code className="text-muted">BotRunsPanel</code> (13 runs, 2 pages) and{" "}
        <code className="text-muted">RecentOrdersPanel</code> (18 raw orders, collapsing to 12
        display rows, 2 pages), plus <code className="text-muted">RecentOrdersPanel</code>&apos;s
        consecutive-rejection collapsing - modeled directly on the real GOOGL/CRWV production
        incident. The 7-order CRWV rejection run spans what would be two different pages by raw
        order count, but collapses into a single correct <code className="text-muted">×7</code>{" "}
        group before pagination ever slices the list, so it always renders as one row regardless of
        which page its individual orders would otherwise land on.
      </p>

      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <BotRunsPanel runs={runs} />
        <RecentOrdersPanel orders={orders} />
      </div>
    </main>
  );
}
