"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { closedMessage } from "./MarketStatusBanner";
import { describeRejection, estimatedAmountLabel } from "./orderMessages";
import { getQuoteForSymbol } from "@/app/actions/quote";
import { placeTrade } from "@/app/actions/trade";
import type { MarketStatus } from "@/lib/trading/market-hours";
import { formatCents, multiply, type Cents } from "@/lib/trading/money";
import { SymbolSchema } from "@/lib/trading/symbol";
import type { RejectReason, Side } from "@/lib/trading/types";

export type OrderTicketProps = {
  // Cash crosses the Server -> Client Component boundary as a string, not a
  // bigint - React Server Components serialization for bigint is new and
  // unproven enough in this stack that there's no reason to be the first
  // place in the app to rely on it. Reconstructed into a real bigint below
  // before any comparison, never treated as a plain number.
  cashCentsString: string;
  heldPositions: readonly { symbol: string; quantity: number }[];
  marketStatus: MarketStatus;
  // Set on the stock detail page, where the symbol is already the page's
  // context - the input becomes a static label instead of a free-text field.
  // Left unset on the dashboard, where the ticket is the one place a symbol
  // gets typed in the first place.
  fixedSymbol?: string;
};

type SubmitOutcome =
  | { kind: "success"; fillPriceCents: Cents; quantity: number; symbol: string; side: Side }
  | { kind: "rejected"; reason: RejectReason }
  | { kind: "error" };

const QUOTE_DEBOUNCE_MS = 400;

const inputClassName =
  "border-default bg-elevated text-fg placeholder:text-subtle focus:border-strong focus:ring-accent w-full rounded-md border px-3 py-2 font-mono text-sm tabular-nums focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export function OrderTicket({
  cashCentsString,
  heldPositions,
  marketStatus,
  fixedSymbol,
}: OrderTicketProps) {
  const cashCents = BigInt(cashCentsString);

  const [side, setSide] = useState<Side>("buy");
  const [symbolInput, setSymbolInput] = useState(fixedSymbol ?? "");
  const [quantityInput, setQuantityInput] = useState("");
  const [quote, setQuote] = useState<{ bidCents: Cents; askCents: Cents } | null>(null);
  const [quoteStatus, setQuoteStatus] = useState<"idle" | "loading" | "unavailable">("idle");
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);
  const [isSubmitting, startSubmit] = useTransition();
  const requestIdRef = useRef(0);

  const symbol = symbolInput.trim().toUpperCase();
  const isValidSymbol = SymbolSchema.safeParse(symbol).success;
  const quantity = Number(quantityInput);
  const isValidQuantity = Number.isInteger(quantity) && quantity > 0;
  const heldQuantity = heldPositions.find((position) => position.symbol === symbol)?.quantity ?? 0;

  // Live quote refetch, debounced, keyed off a request id so a slow
  // response for a symbol the user already changed away from can never
  // overwrite a newer one - without this, typing quickly could leave the
  // estimate showing a stale symbol's price.
  useEffect(() => {
    if (!isValidSymbol) {
      setQuote(null);
      setQuoteStatus("idle");
      return;
    }

    const requestId = ++requestIdRef.current;
    setQuoteStatus("loading");

    const timer = setTimeout(() => {
      getQuoteForSymbol(symbol)
        .then((result) => {
          if (requestId !== requestIdRef.current) return;
          if (result.ok) {
            setQuote({ bidCents: BigInt(result.bidCents), askCents: BigInt(result.askCents) });
            setQuoteStatus("idle");
          } else {
            setQuote(null);
            setQuoteStatus("unavailable");
          }
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setQuote(null);
          setQuoteStatus("unavailable");
        });
    }, QUOTE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [isValidSymbol, symbol]);

  const estimatedAmountCents =
    quote && isValidQuantity
      ? multiply(side === "buy" ? quote.askCents : quote.bidCents, quantity)
      : null;

  const disabledReason = !marketStatus.open
    ? closedMessage(marketStatus)
    : symbolInput.length === 0
      ? "Enter a symbol."
      : !isValidSymbol
        ? "Symbol must be 1-5 letters."
        : quoteStatus === "loading"
          ? "Fetching a price…"
          : quoteStatus === "unavailable"
            ? "No price available for this symbol right now."
            : quantityInput.length === 0
              ? "Enter a quantity."
              : !isValidQuantity
                ? "Quantity must be a whole number greater than zero."
                : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (disabledReason) return;

    startSubmit(async () => {
      try {
        const result = await placeTrade({ symbol, side, quantity });
        if (result.ok) {
          setOutcome({
            kind: "success",
            fillPriceCents: result.fill.priceCents,
            quantity,
            symbol,
            side,
          });
          // Only cleared when the symbol itself was free-text input - on the
          // stock detail page, fixedSymbol means this ticket only ever
          // trades one symbol, and clearing it here would leave symbolInput
          // empty on the next render, making the ticket look broken
          // ("Enter a symbol.") until the page is refreshed.
          if (!fixedSymbol) {
            setSymbolInput("");
          }
          setQuantityInput("");
          // No router.refresh() here - placeTrade's own revalidatePath("/dashboard")
          // is the single mechanism keeping the dashboard's data fresh
          // after an order. See STATE.md for how that was confirmed to be
          // sufficient on its own once router.refresh() was removed.
        } else {
          setOutcome({ kind: "rejected", reason: result.reason });
        }
      } catch {
        setOutcome({ kind: "error" });
      }
    });
  }

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Place order</h2>
      </header>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-4">
        <div className="border-default bg-elevated flex rounded-md border p-0.5">
          <button
            type="button"
            onClick={() => setSide("buy")}
            className={
              side === "buy"
                ? "bg-selected text-gain flex-1 rounded py-1.5 text-sm font-medium"
                : "text-muted hover:text-fg flex-1 rounded py-1.5 text-sm"
            }
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => setSide("sell")}
            className={
              side === "sell"
                ? "bg-selected text-loss flex-1 rounded py-1.5 text-sm font-medium"
                : "text-muted hover:text-fg flex-1 rounded py-1.5 text-sm"
            }
          >
            Sell
          </button>
        </div>

        {fixedSymbol ? (
          <div className="flex items-center justify-between py-1">
            <span className="text-muted text-xs">Symbol</span>
            <span className="text-fg font-mono text-sm font-medium tabular-nums">
              {fixedSymbol}
            </span>
          </div>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">Symbol</span>
            <input
              value={symbolInput}
              onChange={(event) => setSymbolInput(event.target.value.toUpperCase())}
              placeholder="AAPL"
              maxLength={5}
              autoComplete="off"
              className={inputClassName}
            />
          </label>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Quantity</span>
          <input
            value={quantityInput}
            onChange={(event) => setQuantityInput(event.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder="0"
            className={inputClassName}
          />
          {side === "sell" && symbol.length > 0 && (
            <span className="text-subtle text-xs">
              You hold {heldQuantity} share{heldQuantity === 1 ? "" : "s"}.
            </span>
          )}
        </label>

        <div className="flex items-center justify-between py-2">
          <span className="text-muted text-xs">{estimatedAmountLabel(side)}</span>
          <span className="text-fg font-mono text-sm tabular-nums">
            {estimatedAmountCents !== null ? `$${formatCents(estimatedAmountCents)}` : "—"}
          </span>
        </div>
        <p className="text-subtle text-xs leading-snug">
          Estimate only - the actual fill price is determined when the order executes and can
          differ.
        </p>

        {outcome?.kind === "rejected" && (
          <div
            role="alert"
            className="border-warn/30 bg-warn/5 text-warn rounded-md border px-3 py-2 text-xs"
          >
            {describeRejection(outcome.reason, {
              symbol,
              heldQuantity,
              neededCents: estimatedAmountCents,
              availableCents: cashCents,
              marketStatus,
            })}
          </div>
        )}
        {outcome?.kind === "error" && (
          <div
            role="alert"
            className="border-warn/30 bg-warn/5 text-warn rounded-md border px-3 py-2 text-xs"
          >
            Something went wrong placing this order. Try again.
          </div>
        )}
        {outcome?.kind === "success" && (
          <div className="border-default bg-elevated text-fg rounded-md border px-3 py-2 text-xs">
            {outcome.side === "buy" ? "Bought" : "Sold"} {outcome.quantity}{" "}
            {outcome.quantity === 1 ? "share" : "shares"} of {outcome.symbol} at $
            {formatCents(outcome.fillPriceCents)}.
          </div>
        )}

        <button
          type="submit"
          disabled={disabledReason !== null || isSubmitting}
          className="bg-fg text-on-fg mt-1 rounded-md py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? "Placing order…" : `${side === "buy" ? "Buy" : "Sell"} ${symbol || "—"}`}
        </button>
        {disabledReason && !isSubmitting && <p className="text-subtle text-xs">{disabledReason}</p>}
      </form>
    </section>
  );
}
