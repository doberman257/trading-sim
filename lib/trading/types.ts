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
  | "stale_quote";

export type OrderResult = { ok: true; fill: Fill } | { ok: false; reason: RejectReason };
