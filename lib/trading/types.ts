import type { Cents, Shares } from "./money";

export type Side = "buy" | "sell";

export type Quote = {
  symbol: string;
  bidCents: Cents;
  askCents: Cents;
  timestamp: Date;
};

export type Position = {
  quantity: Shares;
  avgCostCents: Cents;
};

export type AccountState = {
  cashCents: Cents;
  positions: ReadonlyMap<string, Position>;
};

export type Fill = {
  side: Side;
  symbol: string;
  quantity: Shares;
  priceCents: Cents;
  totalCents: Cents;
  newCashCents: Cents;
  newPosition: Position | null;
  realizedPnlCents: Cents | null;
};

export type RejectReason =
  | "insufficient_funds"
  | "insufficient_shares"
  | "invalid_quantity"
  | "market_closed"
  | "stale_quote"
  // Alpaca returned a quote with a zero-priced bid or ask - no active
  // two-sided market right now (most often seen while the market is
  // closed), not a real price. See NoTwoSidedQuoteError in
  // lib/market/alpaca.ts, which is what placeMarketOrder catches to
  // produce this reason instead of letting the error propagate.
  | "no_quote";

export type OrderResult = { ok: true; fill: Fill } | { ok: false; reason: RejectReason };
