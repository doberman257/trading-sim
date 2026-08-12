"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { toCents } from "@/lib/trading/money";

type TargetType = "dollar" | "percent";

type CreateBotRunErrorReason = "invalid_capital" | "invalid_profit_target" | "invalid_stop_loss";

function reasonMessage(reason: CreateBotRunErrorReason): string {
  switch (reason) {
    case "invalid_capital":
      return "Capital must be a dollar amount greater than zero.";
    case "invalid_profit_target":
      return "Profit target must be valid (a dollar amount up to the capital committed, or a percent between 0 and 100).";
    case "invalid_stop_loss":
      return "Stop-loss must be valid (a dollar amount up to the capital committed, or a percent between 0 and 100).";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

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

  const disabledReason = getDisabledReason();

  function getDisabledReason(): string | null {
    if (capitalCents === null || capitalCents <= 0n) return "Enter a capital amount.";
    if (profitTargetInput.trim().length === 0) return "Enter a profit target.";
    if (stopLossInput.trim().length === 0) return "Enter a stop-loss.";
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
        <p className="text-subtle text-xs leading-snug">
          Rule: RSI(14) &lt; 30 with price above SMA(50) - one stated rule, applied to a curated
          watchlist. Every trade is tagged and measured; see Bot runs and Bot rule stats below.
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
            className={inputClassName}
          />
          <span className="text-subtle text-xs leading-snug">
            Leave blank to use only the rule&apos;s own exits (profit target, stop-loss, RSI
            recovery, or end-of-day) - no earlier deadline.
          </span>
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
