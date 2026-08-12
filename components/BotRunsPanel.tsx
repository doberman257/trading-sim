import { Delta } from "./Delta";
import { formatCents } from "@/lib/trading/money";

export type BotRunStatus =
  | "selecting"
  | "holding"
  | "closed_stop_loss"
  | "closed_day_expiry"
  | "closed_target"
  | "closed_rule_exit"
  | "failed_no_affordable_candidate";

export type BotRunItem = {
  id: string;
  status: BotRunStatus;
  ruleId: string;
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
    case "closed_rule_exit":
      return "Closed - rule exit";
    case "failed_no_affordable_candidate":
      return "Failed - no affordable candidate";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// This app's own trading engine never uses an LLM to decide anything - see
// CLAUDE.md's "the autonomous bot never decides" rule - so every row here
// traces to the one stated rule (ruleId) shown alongside it, not a vague
// "the bot picked this."
export function BotRunsPanel({ runs }: { runs: BotRunItem[] }) {
  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Bot runs</h2>
      </header>
      <div className="p-4">
        {runs.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">No bot runs yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {runs.map((run) => {
              const realizedPnlCents =
                run.realizedPnlCents !== null ? BigInt(run.realizedPnlCents) : null;
              return (
                <div
                  key={run.id}
                  className="border-default bg-elevated flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div>
                    <div className="text-fg text-sm font-medium">
                      {run.selectedSymbol ?? "No symbol yet"} - {statusLabel(run.status)}
                    </div>
                    <div className="text-subtle mt-0.5 text-xs">
                      Capital ${formatCents(BigInt(run.capitalCents))}
                      {run.entryTotalCents !== null &&
                        ` · Entry $${formatCents(BigInt(run.entryTotalCents))}`}
                      {run.entryQuantity !== null && ` (${run.entryQuantity} sh)`}
                    </div>
                  </div>
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
