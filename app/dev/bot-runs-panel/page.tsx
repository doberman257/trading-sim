import { notFound } from "next/navigation";
import { BotRunsPanel, type BotRunItem } from "@/components/BotRunsPanel";
import {
  BREAKOUT_52WK_HIGH_V1_ID,
  BREAKOUT_52WK_HIGH_V1_PARAMS,
  GOLDEN_CROSS_V1_ID,
  GOLDEN_CROSS_V1_PARAMS,
  RSI_PULLBACK_UPTREND_V1_ID,
  RSI_PULLBACK_UPTREND_V1_PARAMS,
  RSI_PULLBACK_UPTREND_V2_ID,
  RSI_PULLBACK_UPTREND_V2_PARAMS,
} from "@/lib/trading/bot-rule";
import { toCents } from "@/lib/trading/money";

let nextId = 0;
function id(): string {
  nextId += 1;
  return `preview-run-${nextId}`;
}

const now = new Date("2026-08-19T15:00:00Z").toISOString();

const runs: BotRunItem[] = [
  {
    id: id(),
    status: "selecting",
    ruleId: RSI_PULLBACK_UPTREND_V2_ID,
    ruleParams: RSI_PULLBACK_UPTREND_V2_PARAMS,
    capitalCents: toCents("1000.00").toString(),
    selectedSymbol: null,
    entryTotalCents: null,
    entryQuantity: null,
    realizedPnlCents: null,
    createdAt: now,
    closedAt: null,
  },
  {
    id: id(),
    status: "holding",
    ruleId: GOLDEN_CROSS_V1_ID,
    ruleParams: GOLDEN_CROSS_V1_PARAMS,
    capitalCents: toCents("2000.00").toString(),
    selectedSymbol: "AAPL",
    entryTotalCents: toCents("1980.00").toString(),
    entryQuantity: 12,
    realizedPnlCents: null,
    createdAt: now,
    closedAt: null,
  },
  {
    id: id(),
    status: "holding",
    ruleId: BREAKOUT_52WK_HIGH_V1_ID,
    ruleParams: BREAKOUT_52WK_HIGH_V1_PARAMS,
    capitalCents: toCents("5000.00").toString(),
    selectedSymbol: "NVDA",
    entryTotalCents: toCents("4950.00").toString(),
    entryQuantity: 4,
    realizedPnlCents: null,
    createdAt: now,
    closedAt: null,
  },
  {
    id: id(),
    status: "closed_target",
    ruleId: GOLDEN_CROSS_V1_ID,
    ruleParams: GOLDEN_CROSS_V1_PARAMS,
    capitalCents: toCents("1500.00").toString(),
    selectedSymbol: "MSFT",
    entryTotalCents: toCents("1480.00").toString(),
    entryQuantity: 4,
    realizedPnlCents: toCents("74.00").toString(),
    createdAt: now,
    closedAt: now,
  },
  {
    id: id(),
    status: "closed_stop_loss",
    ruleId: BREAKOUT_52WK_HIGH_V1_ID,
    ruleParams: BREAKOUT_52WK_HIGH_V1_PARAMS,
    capitalCents: toCents("3000.00").toString(),
    selectedSymbol: "TSLA",
    entryTotalCents: toCents("2970.00").toString(),
    entryQuantity: 6,
    realizedPnlCents: (-toCents("89.10")).toString(),
    createdAt: now,
    closedAt: now,
  },
  {
    id: id(),
    status: "closed_cancelled",
    ruleId: RSI_PULLBACK_UPTREND_V2_ID,
    ruleParams: RSI_PULLBACK_UPTREND_V2_PARAMS,
    capitalCents: toCents("800.00").toString(),
    selectedSymbol: "AMD",
    entryTotalCents: toCents("790.00").toString(),
    entryQuantity: 5,
    realizedPnlCents: toCents("12.50").toString(),
    createdAt: now,
    closedAt: now,
  },
  {
    id: id(),
    status: "cancelled",
    ruleId: RSI_PULLBACK_UPTREND_V2_ID,
    ruleParams: RSI_PULLBACK_UPTREND_V2_PARAMS,
    capitalCents: toCents("600.00").toString(),
    selectedSymbol: null,
    entryTotalCents: null,
    entryQuantity: null,
    realizedPnlCents: null,
    createdAt: now,
    closedAt: now,
  },
  {
    id: id(),
    status: "failed_no_affordable_candidate",
    ruleId: RSI_PULLBACK_UPTREND_V2_ID,
    ruleParams: RSI_PULLBACK_UPTREND_V2_PARAMS,
    capitalCents: toCents("10.00").toString(),
    selectedSymbol: null,
    entryTotalCents: null,
    entryQuantity: null,
    realizedPnlCents: null,
    createdAt: now,
    closedAt: now,
  },
  // A real, current production case: a run recorded under v1, superseded
  // and no longer in AVAILABLE_STRATEGIES (see RSI_PULLBACK_UPTREND_V1_ID's
  // own header comment) - still gets a real label via describeBotRuleLabel's
  // per-family fallback, not a raw "rsi_pullback_uptrend_v1" string.
  {
    id: id(),
    status: "selecting",
    ruleId: RSI_PULLBACK_UPTREND_V1_ID,
    ruleParams: RSI_PULLBACK_UPTREND_V1_PARAMS,
    capitalCents: toCents("1000.00").toString(),
    selectedSymbol: null,
    entryTotalCents: null,
    entryQuantity: null,
    realizedPnlCents: null,
    createdAt: now,
    closedAt: null,
  },
];

// Design preview only - meaningless once deployed. Same NODE_ENV gate as
// /dev/position-row, not a second auth layer - see that page's own comment
// for why this is sufficient.
export default function BotRunsPanelPreviewPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }

  return (
    <main className="bg-base min-h-screen p-6">
      <p className="text-subtle mb-4 text-xs">
        Design preview only — not part of the dashboard. Demonstrates{" "}
        <code className="text-muted">BotRunsPanel</code> with all three strategies
        (rsi_pullback_uptrend_v2, golden_cross_v1, breakout_52wk_high_v1) mixed in one list, plus a
        superseded/unregistered id (rsi_pullback_uptrend_v1) to confirm its label still falls back
        correctly, across every status: selecting, holding, each closed_* reason, cancelled, and
        closed_cancelled. The Cancel button is interactive here but points at this dev server's own
        API, not a real run - clicking it will 404/error harmlessly against these fixture ids.
      </p>

      <div className="mx-auto max-w-3xl">
        <BotRunsPanel runs={runs} />
      </div>
    </main>
  );
}
