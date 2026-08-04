import { isMarketOpen } from "./market-hours";
import { multiply, type Shares } from "./money";
import type { AccountState, Fill, OrderResult, Position, Quote, Side } from "./types";

const STALE_QUOTE_MS = 60_000;

export function executeMarketOrder(
  account: AccountState,
  quote: Quote,
  side: Side,
  quantity: Shares,
  now: Date = new Date(),
): OrderResult {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { ok: false, reason: "invalid_quantity" };
  }

  // Checked before stale_quote deliberately: once the market's been closed
  // a while, the last quote is definitionally old too, and "market_closed"
  // is the more useful, actionable reason to show than "stale_quote".
  if (!isMarketOpen(now)) {
    return { ok: false, reason: "market_closed" };
  }

  if (now.getTime() - quote.timestamp.getTime() > STALE_QUOTE_MS) {
    return { ok: false, reason: "stale_quote" };
  }

  return side === "buy"
    ? executeBuy(account, quote, quantity)
    : executeSell(account, quote, quantity);
}

function executeBuy(account: AccountState, quote: Quote, quantity: Shares): OrderResult {
  const priceCents = quote.askCents;
  const totalCents = multiply(priceCents, quantity);

  if (account.cashCents < totalCents) {
    return { ok: false, reason: "insufficient_funds" };
  }

  const existing = account.positions.get(quote.symbol);
  const oldQuantity = existing?.quantity ?? 0;
  const oldAvgCostCents = existing?.avgCostCents ?? 0n;
  const newQuantity = oldQuantity + quantity;
  const newAvgCostCents =
    (oldAvgCostCents * BigInt(oldQuantity) + totalCents) / BigInt(newQuantity);

  const newPosition: Position = { quantity: newQuantity, avgCostCents: newAvgCostCents };

  const fill: Fill = {
    side: "buy",
    symbol: quote.symbol,
    quantity,
    priceCents,
    totalCents,
    newCashCents: account.cashCents - totalCents,
    newPosition,
    realizedPnlCents: null,
  };

  return { ok: true, fill };
}

function executeSell(account: AccountState, quote: Quote, quantity: Shares): OrderResult {
  const existing = account.positions.get(quote.symbol);

  if (!existing || existing.quantity < quantity) {
    return { ok: false, reason: "insufficient_shares" };
  }

  const priceCents = quote.bidCents;
  const totalCents = multiply(priceCents, quantity);
  const remainingQuantity = existing.quantity - quantity;
  const realizedPnlCents = (priceCents - existing.avgCostCents) * BigInt(quantity);
  const newPosition: Position | null =
    remainingQuantity === 0
      ? null
      : { quantity: remainingQuantity, avgCostCents: existing.avgCostCents };

  const fill: Fill = {
    side: "sell",
    symbol: quote.symbol,
    quantity,
    priceCents,
    totalCents,
    newCashCents: account.cashCents + totalCents,
    newPosition,
    realizedPnlCents,
  };

  return { ok: true, fill };
}
