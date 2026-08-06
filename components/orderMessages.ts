import { closedMessage } from "./MarketStatusBanner";
import type { MarketStatus } from "@/lib/trading/market-hours";
import { formatCents, type Cents } from "@/lib/trading/money";
import type { RejectReason, Side } from "@/lib/trading/types";

// A buy costs money (it leaves the account); a sell brings money in - it
// has proceeds, not a cost. Reusing "cost" for both sides was wrong on the
// sell side, not just imprecise. Exported and tested for the same reason as
// everything else in this file: a wording bug in a label is still a bug.
export function estimatedAmountLabel(side: Side): string {
  return side === "buy" ? "Estimated cost (ask)" : "Estimated proceeds (bid)";
}

// Kept in its own file, separate from OrderTicket.tsx: that component
// imports Server Actions which transitively import lib/db (a real Postgres
// connection at module load, per lib/db/client.ts), which would make this
// pure, no-DB-needed message logic impossible to unit-test in the default
// suite that intentionally runs with zero environment variables (see
// vitest.config.ts and the CI unit job).
//
// Exported for the same reason as MarketStatusBanner's closedMessage: the
// exact wording is unit-testable without a DOM/render setup this way. Each
// RejectReason gets a specific, contextual message rather than a generic
// "order failed" - and the exhaustive switch means a new RejectReason added
// to lib/trading/types.ts later fails this build instead of silently
// rendering nothing for it.
export function describeRejection(
  reason: RejectReason,
  context: {
    symbol: string;
    heldQuantity: number;
    neededCents: Cents | null;
    availableCents: Cents;
    marketStatus: MarketStatus;
  },
): string {
  switch (reason) {
    case "insufficient_funds":
      return context.neededCents !== null
        ? `Insufficient funds: this order needs ${formatCents(context.neededCents)}, but only ${formatCents(context.availableCents)} is available.`
        : `Insufficient funds: only ${formatCents(context.availableCents)} is available.`;
    case "insufficient_shares":
      return context.heldQuantity > 0
        ? `You only hold ${context.heldQuantity} share${context.heldQuantity === 1 ? "" : "s"} of ${context.symbol}.`
        : `You don't hold any shares of ${context.symbol}.`;
    case "market_closed":
      return closedMessage(context.marketStatus);
    case "stale_quote":
      return "The price quote used for this order has gone stale. Try submitting again for a fresh price.";
    case "invalid_quantity":
      return "Enter a whole number of shares greater than zero.";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
