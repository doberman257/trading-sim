"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { nextApplicableCloseTime } from "@/lib/trading/bot-day-expiry";
import { AVAILABLE_STRATEGIES, maxHoldDays, type BotRuleParams } from "@/lib/trading/bot-rule";
import { toCents } from "@/lib/trading/money";

type TargetType = "dollar" | "percent";

type CreateBotRunErrorReason =
  | "invalid_capital"
  | "invalid_profit_target"
  | "invalid_stop_loss"
  | "invalid_rule_id"
  | "invalid_deadline";

function reasonMessage(reason: CreateBotRunErrorReason): string {
  switch (reason) {
    case "invalid_capital":
      return "Capital must be a dollar amount greater than zero.";
    case "invalid_profit_target":
      return "Profit target must be valid (a dollar amount up to the capital committed, or a percent between 0 and 100).";
    case "invalid_stop_loss":
      return "Stop-loss must be valid (a dollar amount up to the capital committed, or a percent between 0 and 100).";
    case "invalid_rule_id":
      return "Choose a strategy for this run.";
    case "invalid_deadline":
      return "Deadline is later than this strategy's own maximum hold - choose an earlier one.";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

// Mirrors latestAllowedDeadline in lib/db/bot-runs.ts exactly (same two
// pure functions, same "no cap -> same-day close, capped -> N days from
// now" shape) - a client-side ESTIMATE for immediate inline feedback only,
// using this browser's own clock for `now`. createBotRun's own copy is the
// real, authoritative check (using the server's own clock at the moment of
// submission) - this one exists purely so a user sees why a deadline will
// be rejected before they ever submit, not to replace that check.
function latestAllowedDeadlineEstimate(kind: BotRuleParams["kind"], now: Date): Date {
  const days = maxHoldDays(kind);
  if (days === null) {
    return nextApplicableCloseTime(now);
  }
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

// The inline rejection message shown directly under the deadline field
// once its value reads as too late for the selected strategy - stated in
// the same terms as the cap itself (a flat day count, or "today's own
// market close"), not a generic "invalid deadline."
function deadlineTooLateMessage(kind: BotRuleParams["kind"]): string {
  const days = maxHoldDays(kind);
  return days === null
    ? "Deadline can't be later than today's own market close for this strategy."
    : `Deadline can't be later than ${days} days from now for this strategy.`;
}

// The blank-deadline help text's own per-strategy ending - what actually
// happens with no custom deadline set, stated plainly rather than left
// vague ("no earlier deadline" used to describe every strategy identically
// even though timeHorizonDeadlineAt was a complete no-op at the time that
// copy was written - see STATE.md's Gotchas). null maxHoldDays
// (rsi_pullback) closes same-day; a capped rule closes at its own N-day
// max hold, at the latest.
function blankDeadlineHelpText(kind: BotRuleParams["kind"]): string {
  const days = maxHoldDays(kind);
  const capClause =
    days === null
      ? "close automatically at today's own market close (same-day only for this strategy)"
      : `close automatically after ${days} days at the latest (this strategy's own max hold)`;
  return `Leave blank to ${capClause} if no rule-based exit (profit target, stop-loss, or the rule's own reversal signal) fires first.`;
}

// AVAILABLE_STRATEGIES is plain data (see bot-rule.ts's own comment on the
// registry) - safe to import directly into this Client Component rather
// than threading it down as a prop, the same as any other shared constant.
const STRATEGY_IDS = Object.keys(AVAILABLE_STRATEGIES);
const firstStrategyId = STRATEGY_IDS[0];
if (!firstStrategyId) {
  throw new Error(
    "AVAILABLE_STRATEGIES is empty - BotRunForm needs at least one choosable strategy",
  );
}
const DEFAULT_RULE_ID: string = firstStrategyId;

const inputClassName =
  "border-default bg-elevated text-fg placeholder:text-subtle focus:border-strong focus:ring-accent w-full rounded-md border px-3 py-2 font-mono text-sm tabular-nums focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

// A dollar-or-percent pair of inputs, reused identically for profit target
// and stop-loss - one shared shape, not two near-identical field groups,
// since the schema itself (lib/db/schema.ts's bot_runs.profitTarget*/
// stopLoss* columns) treats them as the exact same TargetConfig union.
function TargetInput({
  label,
  type,
  onTypeChange,
  amount,
  onAmountChange,
}: {
  label: string;
  type: TargetType;
  onTypeChange: (type: TargetType) => void;
  amount: string;
  onAmountChange: (amount: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted text-xs">{label}</span>
      <div className="flex gap-2">
        <div className="border-default bg-elevated flex rounded-md border p-0.5">
          <button
            type="button"
            onClick={() => onTypeChange("dollar")}
            className={
              type === "dollar"
                ? "bg-selected text-fg rounded px-2.5 py-1.5 text-sm font-medium"
                : "text-muted hover:text-fg rounded px-2.5 py-1.5 text-sm"
            }
          >
            $
          </button>
          <button
            type="button"
            onClick={() => onTypeChange("percent")}
            className={
              type === "percent"
                ? "bg-selected text-fg rounded px-2.5 py-1.5 text-sm font-medium"
                : "text-muted hover:text-fg rounded px-2.5 py-1.5 text-sm"
            }
          >
            %
          </button>
        </div>
        <input
          value={amount}
          onChange={(event) =>
            onAmountChange(
              event.target.value.replace(type === "dollar" ? /[^0-9.]/g : /[^0-9.]/g, ""),
            )
          }
          inputMode="decimal"
          placeholder={type === "dollar" ? "0.00" : "0"}
          className={inputClassName}
        />
      </div>
    </label>
  );
}

// Starts a new autonomous bot run. Posts directly to the Route Handler
// (app/api/bot/runs/route.ts), not a Server Action - same architecture
// decision as limit orders: a future bot-configuring client should be able
// to start a run the same way a browser session does. capitalCents/
// profitTarget/stopLoss cross this boundary in the exact shapes
// createBotRun (lib/db/bot-runs.ts) and the route's own Zod schema expect -
// a dollar amount as a cents string, a percent as a plain integer of basis
// points (a "5" in the UI becomes 500 basis points).
export function BotRunForm() {
  const router = useRouter();

  const [ruleId, setRuleId] = useState(DEFAULT_RULE_ID);
  const [capitalInput, setCapitalInput] = useState("");
  const [profitTargetType, setProfitTargetType] = useState<TargetType>("dollar");
  const [profitTargetInput, setProfitTargetInput] = useState("");
  const [stopLossType, setStopLossType] = useState<TargetType>("dollar");
  const [stopLossInput, setStopLossInput] = useState("");
  const [deadlineInput, setDeadlineInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, startSubmit] = useTransition();

  let capitalCents: bigint | null = null;
  try {
    if (capitalInput.trim().length > 0) capitalCents = toCents(capitalInput.trim());
  } catch {
    capitalCents = null;
  }

  const selectedKind = AVAILABLE_STRATEGIES[ruleId]?.params.kind ?? null;

  // Parsed once and reused by both the inline field message below and
  // getDisabledReason - a genuinely invalid datetime-local value (should be
  // structurally impossible from the browser's own picker, but not worth
  // trusting blindly) reads as "no deadline chosen" here, the same as
  // leaving the field blank, rather than a separate error state.
  const deadlineDate =
    deadlineInput.trim().length > 0 && !Number.isNaN(new Date(deadlineInput).getTime())
      ? new Date(deadlineInput)
      : null;
  const deadlineCap = selectedKind ? latestAllowedDeadlineEstimate(selectedKind, new Date()) : null;
  const deadlineTooLate =
    deadlineDate !== null && deadlineCap !== null && deadlineDate.getTime() > deadlineCap.getTime();

  const disabledReason = getDisabledReason();

  function getDisabledReason(): string | null {
    if (capitalCents === null || capitalCents <= 0n) return "Enter a capital amount.";
    if (profitTargetInput.trim().length === 0) return "Enter a profit target.";
    if (stopLossInput.trim().length === 0) return "Enter a stop-loss.";
    if (deadlineTooLate) return "Choose a deadline within this strategy's own maximum hold.";
    return null;
  }

  function buildTargetPayload(
    type: TargetType,
    amountInput: string,
  ): { type: "dollar"; valueCents: string } | { type: "percent"; basisPoints: number } | null {
    if (type === "dollar") {
      try {
        return { type: "dollar", valueCents: toCents(amountInput.trim()).toString() };
      } catch {
        return null;
      }
    }
    const percent = Number(amountInput.trim());
    if (!Number.isFinite(percent) || percent <= 0) return null;
    return { type: "percent", basisPoints: Math.round(percent * 100) };
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (disabledReason || capitalCents === null) return;

    const profitTarget = buildTargetPayload(profitTargetType, profitTargetInput);
    const stopLoss = buildTargetPayload(stopLossType, stopLossInput);
    if (!profitTarget || !stopLoss) {
      setError("Enter valid amounts for both the profit target and stop-loss.");
      return;
    }

    setError(null);
    setSuccess(null);

    startSubmit(async () => {
      try {
        const response = await fetch("/api/bot/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ruleId,
            capitalCents: capitalCents.toString(),
            profitTarget,
            stopLoss,
            ...(deadlineInput
              ? { timeHorizonDeadlineAt: new Date(deadlineInput).toISOString() }
              : {}),
          }),
        });
        const body: { ok: true; runId: string } | { ok: false; reason: CreateBotRunErrorReason } =
          await response.json();

        if (body.ok) {
          setSuccess(
            "Bot run started - it will select a symbol and enter as soon as one on the watchlist qualifies.",
          );
          setCapitalInput("");
          setProfitTargetInput("");
          setStopLossInput("");
          setDeadlineInput("");
          router.refresh();
        } else {
          setError(reasonMessage(body.reason));
        }
      } catch {
        setError("Something went wrong starting this bot run. Try again.");
      }
    });
  }

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Start a bot run</h2>
      </header>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-4">
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Strategy</span>
          <select
            value={ruleId}
            onChange={(event) => setRuleId(event.target.value)}
            className={inputClassName}
          >
            {STRATEGY_IDS.map((id) => (
              <option key={id} value={id}>
                {AVAILABLE_STRATEGIES[id]!.label}
              </option>
            ))}
          </select>
          <span className="text-subtle text-xs leading-snug">
            {AVAILABLE_STRATEGIES[ruleId]?.description}
          </span>
        </label>
        <p className="text-subtle text-xs leading-snug">
          One stated rule per run, applied to a curated watchlist. Every trade is tagged and
          measured; see Bot runs and Bot rule stats below.
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Capital</span>
          <input
            value={capitalInput}
            onChange={(event) => setCapitalInput(event.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder="1000.00"
            className={inputClassName}
          />
        </label>
        <TargetInput
          label="Profit target"
          type={profitTargetType}
          onTypeChange={setProfitTargetType}
          amount={profitTargetInput}
          onAmountChange={setProfitTargetInput}
        />
        <TargetInput
          label="Stop-loss"
          type={stopLossType}
          onTypeChange={setStopLossType}
          amount={stopLossInput}
          onAmountChange={setStopLossInput}
        />
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Deadline (optional)</span>
          <input
            type="datetime-local"
            value={deadlineInput}
            onChange={(event) => setDeadlineInput(event.target.value)}
            aria-invalid={deadlineTooLate}
            className={inputClassName}
          />
          {deadlineTooLate && selectedKind && (
            <span role="alert" className="text-warn text-xs leading-snug">
              {deadlineTooLateMessage(selectedKind)}
            </span>
          )}
          {!deadlineTooLate && deadlineInput.trim().length === 0 && selectedKind && (
            <span className="text-subtle text-xs leading-snug">
              {blankDeadlineHelpText(selectedKind)}
            </span>
          )}
        </label>

        {error && (
          <div
            role="alert"
            className="border-warn/30 bg-warn/5 text-warn rounded-md border px-3 py-2 text-xs"
          >
            {error}
          </div>
        )}
        {success && (
          <div className="border-default bg-elevated text-fg rounded-md border px-3 py-2 text-xs">
            {success}
          </div>
        )}

        <button
          type="submit"
          disabled={disabledReason !== null || isSubmitting}
          className="bg-fg text-on-fg mt-1 rounded-md py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? "Starting…" : "Start bot run"}
        </button>
        {disabledReason && !isSubmitting && <p className="text-subtle text-xs">{disabledReason}</p>}
      </form>
    </section>
  );
}
