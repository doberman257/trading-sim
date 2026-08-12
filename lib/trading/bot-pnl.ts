import type { Cents } from "./money";

// A bot run's realized P&L once it closes, for the one denormalized column
// this measurement layer needs fast (bot_runs.realizedPnlCents) - see
// lib/db/schema.ts's own comment on why caching this is acceptable under
// CLAUDE.md's "don't reimplement money math" rule: it isn't a second
// computation of the same value by different logic, it's the same
// subtraction executeSell already does internally
// (priceCents - avgCostCents) * quantity, collapsed to entry/exit totals
// since a bot run only ever holds one lot bought once. Kept as its own
// named, tested function rather than inlined in lib/db/bot-runs.ts because
// this number is explicitly "the actual point of the project" per the
// design brief - it earns the same test discipline as any other money
// calculation in this app, not an ad hoc expression at a call site.
export function computeBotRunRealizedPnl(entryTotalCents: Cents, exitTotalCents: Cents): Cents {
  return exitTotalCents - entryTotalCents;
}
