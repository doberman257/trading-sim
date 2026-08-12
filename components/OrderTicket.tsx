"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { closedMessage } from "./MarketStatusBanner";
import { describeRejection, estimatedAmountLabel, limitOrderAmountLabel } from "./orderMessages";
import { StockQuoteCard } from "./StockQuoteCard";
import { SymbolAutocomplete } from "./SymbolAutocomplete";
import { getQuoteForSymbol } from "@/app/actions/quote";
import { placeTrade } from "@/app/actions/trade";
import type { MarketStatus } from "@/lib/trading/market-hours";
import { formatCents, multiply, toCents, type Cents } from "@/lib/trading/money";
import { SymbolSchema } from "@/lib/trading/symbol";
import type { RejectReason, Side } from "@/lib/trading/types";

type OrderType = "market" | "limit";

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
  | { kind: "limit_pending"; limitPriceCents: Cents; quantity: number; symbol: string; side: Side }
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
  const router = useRouter();

  const [orderType, setOrderType] = useState<OrderType>("market");
  const [side, setSide] = useState<Side>("buy");
  const [symbolInput, setSymbolInput] = useState(fixedSymbol ?? "");
  const [quantityInput, setQuantityInput] = useState("");
  const [limitPriceInput, setLimitPriceInput] = useState("");
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

  // toCents throws on anything that isn't a plain "123" or "123.45" shape -
  // caught here rather than pre-filtering every keystroke, so a
  // momentarily malformed value (e.g. mid-edit "1.") just reads as "not
  // valid yet" instead of fighting the user's typing.
  let limitPriceCents: Cents | null = null;
  if (limitPriceInput.trim().length > 0) {
    try {
      limitPriceCents = toCents(limitPriceInput.trim());
    } catch {
      limitPriceCents = null;
    }
  }
  const isValidLimitPrice = limitPriceCents !== null && limitPriceCents > 0n;

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

  // A limit order's own bound - quantity times its own limit price, not
  // the current quote - since that's what estimatedAmountCents means for
  // this order type (see limitOrderAmountLabel). Also what's shown as
  // "needed" if the order gets rejected for insufficient funds/shares.
  const limitBoundCents =
    limitPriceCents !== null && isValidQuantity ? multiply(limitPriceCents, quantity) : null;

  // A limit order never needs the market to be open or a live quote to be
  // ACCEPTED - see lib/trading/limit-reservation.ts's own note on why
  // canPlaceLimitOrder checks neither. It still needs a valid symbol,
  // quantity, and limit price, same as a market order needs a valid
  // symbol and quantity.
  const disabledReason =
    orderType === "market" ? getMarketOrderDisabledReason() : getLimitOrderDisabledReason();

  function getMarketOrderDisabledReason(): string | null {
    if (!marketStatus.open) return closedMessage(marketStatus);
    if (symbolInput.length === 0) return "Enter a symbol.";
    if (!isValidSymbol) return "Symbol must be 1-5 letters.";
    if (quoteStatus === "loading") return "Fetching a price…";
    if (quoteStatus === "unavailable") return "No price available for this symbol right now.";
    if (quantityInput.length === 0) return "Enter a quantity.";
    if (!isValidQuantity) return "Quantity must be a whole number greater than zero.";
    return null;
  }

  function getLimitOrderDisabledReason(): string | null {
    if (symbolInput.length === 0) return "Enter a symbol.";
    if (!isValidSymbol) return "Symbol must be 1-5 letters.";
    if (quantityInput.length === 0) return "Enter a quantity.";
    if (!isValidQuantity) return "Quantity must be a whole number greater than zero.";
    if (limitPriceInput.length === 0) return "Enter a limit price.";
    if (!isValidLimitPrice) return "Limit price must be a dollar amount greater than zero.";
    return null;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (disabledReason) return;

    startSubmit(async () => {
      try {
        if (orderType === "limit") {
          await submitLimitOrder();
          return;
        }

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

  // Calls the Route Handler directly via fetch, not a Server Action - see
  // app/api/orders/limit/route.ts's own comment on why this exists as a
  // Route Handler in the first place. Any thrown error (a network failure,
  // a malformed response) propagates up to handleSubmit's own try/catch,
  // which is what sets outcome to "error" - this function only handles
  // the well-formed ok:true/ok:false response shape.
  async function submitLimitOrder(): Promise<void> {
    if (limitPriceCents === null) return; // disabledReason already guards this; narrows for TS.
    const submittedLimitPriceCents = limitPriceCents;

    const response = await fetch("/api/orders/limit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        side,
        quantity,
        limitPriceCents: submittedLimitPriceCents.toString(),
      }),
    });
    const body: { ok: true; orderId: string } | { ok: false; reason: RejectReason } =
      await response.json();

    if (body.ok) {
      setOutcome({
        kind: "limit_pending",
        limitPriceCents: submittedLimitPriceCents,
        quantity,
        symbol,
        side,
      });
      if (!fixedSymbol) {
        setSymbolInput("");
      }
      setQuantityInput("");
      setLimitPriceInput("");
      // Unlike placeTrade's Server Action, a plain fetch to a Route
      // Handler has no automatic client Router Cache invalidation tied to
      // it - the route's own revalidatePath call only marks the
      // server-side cache stale. This is what actually makes the
      // dashboard/stock page's pending-orders panel show the new order.
      router.refresh();
    } else {
      setOutcome({ kind: "rejected", reason: body.reason });
    }
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

        <div className="border-default bg-elevated flex rounded-md border p-0.5">
          <button
            type="button"
            onClick={() => setOrderType("market")}
            className={
              orderType === "market"
                ? "bg-selected text-fg flex-1 rounded py-1.5 text-sm font-medium"
                : "text-muted hover:text-fg flex-1 rounded py-1.5 text-sm"
            }
          >
            Market
          </button>
          <button
            type="button"
            onClick={() => setOrderType("limit")}
            className={
              orderType === "limit"
                ? "bg-selected text-fg flex-1 rounded py-1.5 text-sm font-medium"
                : "text-muted hover:text-fg flex-1 rounded py-1.5 text-sm"
            }
          >
            Limit
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
            <SymbolAutocomplete
              value={symbolInput}
              onValueChange={setSymbolInput}
              onSelect={setSymbolInput}
              placeholder="AAPL or company name"
              inputClassName={inputClassName}
            />
          </label>
        )}

        {/* Immediately visible once a symbol is chosen, not just at
            submit - the same bid/ask/spread StockQuoteCard already shows
            on the stock detail page, sized for this narrower column
            (compact) and, for a limit order, without the wide-spread
            caveat: that caveat is about the risk of transacting against
            the CURRENT quote right now, which a limit order deliberately
            doesn't do.

            Only rendered when the symbol is searchable (no fixedSymbol) -
            when fixedSymbol IS set, the stock detail page already shows
            this exact symbol's full-size StockQuoteCard just above the
            tabs, always visible regardless of which tab is active. Showing
            the same bid/ask/spread a second time, inside the ticket, would
            just be the same numbers twice on screen at once - the ticket's
            own copy earns its place only where it's the sole source of
            price info, which today means the dashboard's free-search
            context specifically. */}
        {!fixedSymbol &&
          isValidSymbol &&
          (quoteStatus === "loading" ? (
            <p className="text-muted text-xs">Fetching price…</p>
          ) : (
            <StockQuoteCard
              symbol={symbol}
              bidCents={quote?.bidCents ?? null}
              askCents={quote?.askCents ?? null}
              isStale={!marketStatus.open}
              compact
              showWideSpreadWarning={orderType === "market"}
            />
          ))}

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

        {orderType === "limit" && (
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">Limit price</span>
            <input
              value={limitPriceInput}
              onChange={(event) => setLimitPriceInput(event.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0.00"
              className={inputClassName}
            />
          </label>
        )}

        <div className="flex items-center justify-between py-2">
          <span className="text-muted text-xs">
            {orderType === "market" ? estimatedAmountLabel(side) : limitOrderAmountLabel(side)}
          </span>
          <span className="text-fg font-mono text-sm tabular-nums">
            {orderType === "market"
              ? estimatedAmountCents !== null
                ? `$${formatCents(estimatedAmountCents)}`
                : "—"
              : limitBoundCents !== null
                ? `$${formatCents(limitBoundCents)}`
                : "—"}
          </span>
        </div>
        {orderType === "market" ? (
          <p className="text-subtle text-xs leading-snug">
            Estimate only - the actual fill price is determined when the order executes and can
            differ.
          </p>
        ) : (
          <p className="text-subtle text-xs leading-snug">
            Rests until {side === "buy" ? "the ask falls to" : "the bid rises to"} your limit price
            or better, or expires at the end of the trading day if it never fills.
          </p>
        )}

        {outcome?.kind === "rejected" && (
          <div
            role="alert"
            className="border-warn/30 bg-warn/5 text-warn rounded-md border px-3 py-2 text-xs"
          >
            {describeRejection(outcome.reason, {
              symbol,
              heldQuantity,
              neededCents: orderType === "market" ? estimatedAmountCents : limitBoundCents,
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
        {outcome?.kind === "limit_pending" && (
          <div className="border-default bg-elevated text-fg rounded-md border px-3 py-2 text-xs">
            {outcome.side === "buy" ? "Buy" : "Sell"} order for {outcome.quantity}{" "}
            {outcome.quantity === 1 ? "share" : "shares"} of {outcome.symbol} at $
            {formatCents(outcome.limitPriceCents)} is now pending.
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
