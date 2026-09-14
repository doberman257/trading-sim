"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Delta } from "./Delta";
import { Pagination } from "./Pagination";
import { SortDropdown, type SortDropdownOption } from "./SortDropdown";
import { DEFAULT_PAGE_SIZE, clampPage, getPageCount, paginate } from "@/lib/pagination";
import { describeBotRuleLabel, describeBotRuleParams } from "@/lib/trading/bot-rule";
import { formatCents } from "@/lib/trading/money";
import type { RejectReason } from "@/lib/trading/types";

export type BotRunStatus =
  | "selecting"
  | "holding"
  | "closed_stop_loss"
  | "closed_day_expiry"
  | "closed_max_hold"
  | "closed_target"
  | "closed_rule_exit"
  | "failed_no_affordable_candidate"
  | "cancelled"
  | "closed_cancelled";

export type BotRunItem = {
  id: string;
  status: BotRunStatus;
  ruleId: string;
  // Raw, unparsed JSON, same as BotRuleStatsItem's own ruleParams
  // (BotStatsPanel.tsx) - describeBotRuleLabel/describeBotRuleParams turn
  // this into display text, not this component directly.
  ruleParams: unknown;
  // Cross the Server -> Client boundary as strings, same convention as
  // every other money value in this app - see OrderTicket's cashCentsString.
  capitalCents: string;
  selectedSymbol: string | null;
  entryTotalCents: string | null;
  entryQuantity: number | null;
  realizedPnlCents: string | null;
  createdAt: string;
  closedAt: string | null;
};

// The route's own serialized CancelBotRunResult (lib/db/bot-runs.ts) -
// realizedPnlCents crosses as a string, same convention as everywhere else.
type CancelBotRunApiResult =
  | { ok: true; status: "cancelled" }
  | { ok: true; status: "closed_cancelled"; realizedPnlCents: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_entered" }
  | {
      ok: false;
      reason: "already_closed";
      actualStatus: BotRunStatus;
      realizedPnlCents: string | null;
    }
  | { ok: false; reason: "already_resolved"; actualStatus: BotRunStatus }
  | { ok: false; reason: RejectReason };

// Not gain/loss colored (that's reserved for realized P&L direction, per
// the design skill) - a run's own lifecycle status is a state, not a
// financial direction, the same reasoning RecentOrdersPanel already applies
// to a plain order's status.
function statusLabel(status: BotRunStatus): string {
  switch (status) {
    case "selecting":
      return "Selecting";
    case "holding":
      return "Holding";
    case "closed_target":
      return "Closed - target hit";
    case "closed_stop_loss":
      return "Closed - stop-loss hit";
    case "closed_day_expiry":
      return "Closed - day expiry";
    case "closed_max_hold":
      return "Closed - max hold reached";
    case "closed_rule_exit":
      return "Closed - rule exit";
    case "failed_no_affordable_candidate":
      return "Failed - no affordable candidate";
    case "cancelled":
      return "Cancelled";
    case "closed_cancelled":
      return "Closed - cancelled";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// This app's own null-vs-zero discipline applies to sorting too, not just
// display: a still-open run's realizedPnlCents is null (no outcome yet),
// which is a different fact from a closed run that broke exactly even at
// $0.00 - a P&L sort must never let "no data yet" read as either the best
// or worst outcome depending on direction. Explicit nulls-last in BOTH
// directions, not left to Postgres/Array.sort's own default (which flips
// which end nulls land on between ascending and descending unless forced).
export type BotRunSortKey = "newest" | "status" | "strategy" | "pnl";

export const BOT_RUN_SORT_OPTIONS: readonly SortDropdownOption<BotRunSortKey>[] = [
  { value: "newest", label: "Newest" },
  { value: "status", label: "Status" },
  { value: "strategy", label: "Strategy" },
  { value: "pnl", label: "P&L" },
];

export function sortBotRuns(runs: BotRunItem[], sortKey: BotRunSortKey): BotRunItem[] {
  const sorted = [...runs];
  switch (sortKey) {
    case "newest":
      sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      break;
    case "status":
      sorted.sort((a, b) => a.status.localeCompare(b.status));
      break;
    case "strategy":
      sorted.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
      break;
    case "pnl":
      sorted.sort((a, b) => {
        const aPnl = a.realizedPnlCents !== null ? BigInt(a.realizedPnlCents) : null;
        const bPnl = b.realizedPnlCents !== null ? BigInt(b.realizedPnlCents) : null;
        if (aPnl === null && bPnl === null) return 0;
        if (aPnl === null) return 1; // nulls last
        if (bPnl === null) return -1; // nulls last
        if (bPnl > aPnl) return 1;
        if (bPnl < aPnl) return -1;
        return 0;
      });
      break;
    default: {
      const _exhaustive: never = sortKey;
      return _exhaustive;
    }
  }
  return sorted;
}

// Own message set, not a reuse of components/orderMessages.ts's
// describeRejection - that function needs order-ticket-specific context
// (available cash, held quantity, market status) this panel doesn't carry,
// and a cancellation's own outcomes (already_entered/already_closed/
// already_resolved) aren't RejectReason values at all. Same "own function
// per real context" precedent as PendingOrdersPanel's own local
// cancelReasonMessage, not centralized there either.
function cancelOutcomeMessage(result: CancelBotRunApiResult): string {
  if (result.ok) {
    return result.status === "cancelled"
      ? "Run cancelled - no position was ever entered."
      : "Run cancelled - the held position was sold.";
  }
  switch (result.reason) {
    case "not_found":
      return "This bot run could not be found.";
    case "already_entered":
      return "The worker entered this run just before it could be cancelled - try cancelling again to close the position.";
    case "already_closed":
      return `This run had already closed (${statusLabel(result.actualStatus)}) just before it could be cancelled.`;
    case "already_resolved":
      return `This run had already resolved (${statusLabel(result.actualStatus)}) just before it could be cancelled.`;
    case "market_closed":
      return "The market is closed - the held position could not be sold right now.";
    case "stale_quote":
      return "The price quote went stale trying to close this position. Try cancelling again for a fresh price.";
    case "no_quote":
      return "No live price is available for this position right now - try again shortly.";
    case "insufficient_shares":
    case "invalid_quantity":
    case "insufficient_funds":
    case "invalid_limit_price":
      // Structurally impossible for this call path (a plain market sell of
      // an already-tracked position: quantity comes from the run's own
      // entryQuantity, never zero or negative; a sell needs no funds
      // check) - kept in the exhaustive switch anyway since this reuses
      // the shared RejectReason type, not to silently swallow a future
      // variant added to that type for an unrelated reason.
      return "Something went wrong closing this run's position. Try again.";
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

// A quiet, neutral tag - not a per-strategy accent color. Three strategies
// is a small, bounded set (like the chart's own SMA/EMA overlay lines - see
// the trading-ui-design skill's own note on when a new token is warranted),
// but unlike those overlays, badges in a vertical list are never rendered
// overlapping each other, so there's no real legibility need for color to
// separate them the way overlapping chart lines do - the label TEXT itself
// already disambiguates at a glance. Inventing a third categorical color
// axis (alongside gain/loss and warn) for a distinction that reads fine in
// plain text would spend one of this system's few reserved colors on
// decoration, which the skill's own core principle rules out.
function StrategyBadge({ label }: { label: string }) {
  return (
    <span className="border-default bg-elevated text-muted shrink-0 rounded-md border px-1.5 py-0.5 text-xs font-normal">
      {label}
    </span>
  );
}

// This app's own trading engine never uses an LLM to decide anything - see
// CLAUDE.md's "the autonomous bot never decides" rule - so every row here
// traces to the one stated rule (ruleId) shown alongside it, not a vague
// "the bot picked this."
export function BotRunsPanel({ runs }: { runs: BotRunItem[] }) {
  const router = useRouter();
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [messageByRunId, setMessageByRunId] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();
  const [sortKey, setSortKey] = useState<BotRunSortKey>("newest");
  const [page, setPage] = useState(1);

  const sortedRuns = sortBotRuns(runs, sortKey);
  const pageCount = getPageCount(sortedRuns.length, DEFAULT_PAGE_SIZE);
  const pageRuns = paginate(sortedRuns, page, DEFAULT_PAGE_SIZE);

  function handleSortChange(next: BotRunSortKey): void {
    setSortKey(next);
    setPage(1);
  }

  function handleCancel(runId: string) {
    setCancellingId(runId);
    setMessageByRunId((prev) => {
      const next = { ...prev };
      delete next[runId];
      return next;
    });

    startTransition(async () => {
      try {
        const response = await fetch(`/api/bot/runs/${runId}/cancel`, { method: "POST" });
        const body: CancelBotRunApiResult = await response.json();
        setMessageByRunId((prev) => ({ ...prev, [runId]: cancelOutcomeMessage(body) }));

        // A plain fetch to a Route Handler, unlike a Server Action, has no
        // automatic client Router Cache invalidation tied to it - the
        // route's own revalidatePath call only marks the server-side cache
        // stale. This is what actually makes the page re-fetch and show
        // the run's new state.
        router.refresh();
      } catch {
        setMessageByRunId((prev) => ({
          ...prev,
          [runId]: "Something went wrong cancelling this run. Try again.",
        }));
      } finally {
        setCancellingId(null);
      }
    });
  }

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Bot runs</h2>
        {sortedRuns.length > 0 && (
          <SortDropdown
            label="Sort"
            value={sortKey}
            options={BOT_RUN_SORT_OPTIONS}
            onChange={handleSortChange}
          />
        )}
      </header>
      <div className="p-4">
        {sortedRuns.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">No bot runs yet.</p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {pageRuns.map((run) => {
                const realizedPnlCents =
                  run.realizedPnlCents !== null ? BigInt(run.realizedPnlCents) : null;
                const cancellable = run.status === "selecting" || run.status === "holding";
                const strategyLabel = describeBotRuleLabel(run.ruleId, run.ruleParams);
                const paramsSummary = describeBotRuleParams(run.ruleParams);
                return (
                  <div
                    key={run.id}
                    className="border-default bg-elevated flex items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <div>
                      <div className="text-fg flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span>
                          {run.selectedSymbol ?? "No symbol yet"} - {statusLabel(run.status)}
                        </span>
                        <StrategyBadge label={strategyLabel} />
                      </div>
                      <div className="text-subtle mt-0.5 text-xs">
                        Capital ${formatCents(BigInt(run.capitalCents))}
                        {run.entryTotalCents !== null &&
                          ` · Entry $${formatCents(BigInt(run.entryTotalCents))}`}
                        {run.entryQuantity !== null && ` (${run.entryQuantity} sh)`}
                        {paramsSummary && ` · ${paramsSummary}`}
                      </div>
                      {messageByRunId[run.id] && (
                        <p className="text-warn mt-1 text-xs">{messageByRunId[run.id]}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {realizedPnlCents !== null && (
                        <Delta
                          cents={realizedPnlCents}
                          percent={
                            run.entryTotalCents && BigInt(run.entryTotalCents) !== 0n
                              ? (Number(realizedPnlCents) / Number(run.entryTotalCents)) * 100
                              : 0
                          }
                          showCurrency
                        />
                      )}
                      {cancellable && (
                        <button
                          type="button"
                          onClick={() => handleCancel(run.id)}
                          disabled={cancellingId === run.id}
                          className="border-default hover:bg-selected shrink-0 rounded-md border px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {cancellingId === run.id ? "Cancelling…" : "Cancel"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
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
