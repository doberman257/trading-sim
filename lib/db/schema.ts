import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const orderSideEnum = pgEnum("order_side", ["buy", "sell"]);
export const orderTypeEnum = pgEnum("order_type", ["market", "limit"]);
export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "filled",
  "cancelled",
  "rejected",
  // A pending limit order the worker swept because the market closed while
  // it was still unfilled - day orders only, see limitOrderWorkerRuns and
  // app/api/worker/limit-orders/route.ts. Distinct from "cancelled" (a user
  // action) and "rejected" (never accepted in the first place) - this is a
  // resting order that WAS accepted and simply ran out of trading day.
  "expired",
]);
export const transactionKindEnum = pgEnum("transaction_kind", ["deposit", "buy", "sell"]);
export const assetSyncStatusEnum = pgEnum("asset_sync_status", ["running", "succeeded", "failed"]);
// Same three-state shape as assetSyncStatusEnum (running while in flight,
// then succeeded or failed) but kept as its own named Postgres type rather
// than reused, matching how every other append-only run log in this schema
// gets its own enum even when the values happen to overlap.
export const limitOrderWorkerRunStatusEnum = pgEnum("limit_order_worker_run_status", [
  "running",
  "succeeded",
  "failed",
]);
// Same three-state shape again, its own named type for the same reason -
// see botWorkerRuns below.
export const botWorkerRunStatusEnum = pgEnum("bot_worker_run_status", [
  "running",
  "succeeded",
  "failed",
]);
// The bot run lifecycle - see lib/db/bot-runs.ts for the state machine this
// enum drives. "selecting" and "holding" are the two in-flight states (no
// candidate found yet vs. a position is open); every "closed_*" value names
// which of the four exit conditions actually fired, since that's exactly
// the label the measurement layer (STATE.md's "actual point of the
// project") needs to answer "did this rule show any edge" later -
// collapsing all four into one generic "closed" would throw away the one
// piece of information that question depends on.
export const botRunStatusEnum = pgEnum("bot_run_status", [
  "selecting",
  "holding",
  "closed_stop_loss",
  "closed_day_expiry",
  "closed_target",
  "closed_rule_exit",
  // No candidate on the watchlist both satisfied the entry rule AND could
  // be sized to at least 1 share within capitalCents - a genuine, real
  // outcome (not an error), same discriminated-outcome discipline as
  // RejectReason elsewhere in this app.
  "failed_no_affordable_candidate",
  // User-initiated cancellation of a "selecting" run - no position was ever
  // entered, so this is NOT one of the closed_* reasons above (those all
  // imply a real exit happened). Named "cancelled" to match how
  // orders.status already uses that exact term for the same concept (a
  // user backing out of something before it took effect).
  "cancelled",
  // User-initiated cancellation of a "holding" run - a real position DID
  // exist and this DOES trigger a real market sell to close it, so unlike
  // "cancelled" above, this belongs in the closed_* family alongside
  // closed_stop_loss/closed_target/closed_rule_exit/closed_day_expiry - the
  // same kind of event (a real exit), just user-initiated instead of the
  // rule/worker's own decision.
  "closed_cancelled",
  // A run's own effective deadline was reached - either the rule family's
  // own fixed max-hold cap (maxHoldDays in lib/trading/bot-rule.ts, null
  // for rsi_pullback, 30 days for golden_cross/breakout - see each params
  // constant's own comment for the real historical binding rate) or a
  // user's own earlier timeHorizonDeadlineAt, whichever comes first.
  // Deliberately distinct from closed_day_expiry, which stays reserved for
  // "no cap and no custom deadline applied - the default same-trading-day
  // close fired" specifically (rsi_pullback with no custom deadline,
  // unchanged from before this status existed) - reusing closed_day_expiry
  // for an exit that can happen weeks later would make BotRunsPanel's own
  // "Closed - day expiry" label read wrong.
  "closed_max_hold",
]);
// Shared by profitTarget/stopLoss below - both are "user picks dollar or
// percent, per session" per the design brief, and the two configs have
// identical shape, so one named Postgres type covers both rather than two
// enums with the same two values.
export const botTargetTypeEnum = pgEnum("bot_target_type", ["dollar", "percent"]);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  // References Supabase's auth.users.id. Not modeled here since auth.users
  // lives in Supabase's own schema, not something Drizzle manages.
  userId: uuid("user_id").notNull().unique(),
  cashCents: bigint("cash_cents", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    symbol: text("symbol").notNull(),
    quantity: integer("quantity").notNull(),
    avgCostCents: bigint("avg_cost_cents", { mode: "bigint" }).notNull(),
  },
  // Unique, not just indexed: one position row per (account, symbol) is a
  // real invariant, and lib/db/orders.ts relies on it to upsert positions.
  (table) => [uniqueIndex("positions_account_symbol_idx").on(table.accountId, table.symbol)],
);

// A bot-initiated investment cycle: pick a symbol, buy it with a fixed
// capital budget, and exit on whichever condition fires first - rule
// reversal, profit target, stop-loss, or a time-based cap (same-trading-day
// close for rsi_pullback, a 30-day max hold for golden_cross/breakout, or
// a user's own earlier deadline - see lib/trading/bot-rule.ts's
// maxHoldDays) - see lib/db/bot-runs.ts. One row per run, not per trade: a run's entry buy and
// its eventual exit sell are both ordinary rows in `orders` below, tagged
// with this run's id via orders.botRunId, so nothing about order placement
// or fill accounting is duplicated here - this table exists to carry what
// no single order row could (the rule/params that drove the run, the
// user's target/stop-loss config, and the run's own lifecycle status), not
// to re-record what `orders`/`transactions` already record correctly.
export const botRuns = pgTable("bot_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  status: botRunStatusEnum("status").notNull().default("selecting"),
  // The rule id/params that drove this specific run (e.g.
  // "rsi_pullback_uptrend_v1", { rsiPeriod: 14, rsiEntryThreshold: 30, ... })
  // - stored on the run, not derived from code, so a later change to the
  // rule's default parameters never silently reinterprets what an already-
  // closed run actually did. This is the one field the measurement layer
  // (STATE.md) groups by to keep one rule version's stats from being
  // contaminated by another's.
  ruleId: text("rule_id").notNull(),
  ruleParams: jsonb("rule_params").notNull(),
  capitalCents: bigint("capital_cents", { mode: "bigint" }).notNull(),
  profitTargetType: botTargetTypeEnum("profit_target_type").notNull(),
  // Exactly one of these two is set, matching profitTargetType - see
  // lib/trading/bot-targets.ts's validateTargetConfig, which is what
  // enforces this pair stays consistent before a row is ever inserted.
  profitTargetValueCents: bigint("profit_target_value_cents", { mode: "bigint" }),
  profitTargetBasisPoints: integer("profit_target_basis_points"),
  stopLossType: botTargetTypeEnum("stop_loss_type").notNull(),
  stopLossValueCents: bigint("stop_loss_value_cents", { mode: "bigint" }),
  stopLossBasisPoints: integer("stop_loss_basis_points"),
  // An optional, user-chosen EARLIER deadline than whatever the rule's own
  // effective cap already is (same-day for rsi_pullback, 30 days from
  // entry for golden_cross/breakout - see maxHoldDays in
  // lib/trading/bot-rule.ts). createBotRun rejects any value later than
  // that cap outright (invalid_deadline), so once stored, this can only
  // ever pull an exit EARLIER than the rule's own cap, never override it -
  // monitorOneBotRun takes whichever of the two is sooner. Actually wired
  // into the exit-priority check as of the maxHoldDays round - before that,
  // this field was accepted, validated, and stored, but never once read by
  // anything, a real no-op for every value regardless of the day-expiry
  // question (see STATE.md's Gotchas).
  timeHorizonDeadlineAt: timestamp("time_horizon_deadline_at", { withTimezone: true }),
  // Set once selection succeeds - null while status is still "selecting".
  selectedSymbol: text("selected_symbol"),
  // The actual cost of the entry fill (quantity x fill price), which can be
  // less than capitalCents once whole-share rounding leaves a remainder -
  // see lib/trading/bot-sizing.ts. This, not capitalCents, is what
  // realizedPnlCents and the stop-loss/profit-target percent calculations
  // below are measured against.
  entryTotalCents: bigint("entry_total_cents", { mode: "bigint" }),
  // The entry fill's own quantity - kept here too, not just derivable by
  // joining back to the entry order row, since every monitoring cycle for a
  // "holding" run needs it (to value the position and to size the eventual
  // exit sell) and this avoids a repeated join for something that never
  // changes once set.
  entryQuantity: integer("entry_quantity"),
  // The entry fill's own timestamp - same "avoid a repeated join back to
  // the entry order row every monitoring cycle" reasoning as entryQuantity
  // above. This, not createdAt (when the run started SELECTING, which can
  // be well before an actual entry fill), is what a rule family's own
  // maxHoldDays cap is measured from.
  entryFilledAt: timestamp("entry_filled_at", { withTimezone: true }),
  // Denormalized from the exit order's own fill, the same way
  // transactions.balanceAfterCents already caches a value computed once
  // elsewhere rather than re-deriving it - see lib/trading/bot-pnl.ts. Null
  // until the run closes.
  realizedPnlCents: bigint("realized_pnl_cents", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    symbol: text("symbol").notNull(),
    side: orderSideEnum("side").notNull(),
    type: orderTypeEnum("type").notNull(),
    quantity: integer("quantity").notNull(),
    limitPriceCents: bigint("limit_price_cents", { mode: "bigint" }),
    status: orderStatusEnum("status").notNull().default("pending"),
    filledPriceCents: bigint("filled_price_cents", { mode: "bigint" }),
    rejectReason: text("reject_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    filledAt: timestamp("filled_at", { withTimezone: true }),
    // Null for every order a human placed directly - only set on an order
    // this app itself placed on a bot run's behalf (the entry buy, the
    // resting profit-target limit sell, or a stop-loss/rule-exit/day-expiry
    // market sell). This is the one column the whole measurement layer
    // depends on: "every bot-initiated trade tagged as bot-originated" from
    // the design brief, done via a tag on the existing orders table rather
    // than a parallel bot-trades ledger that could drift from it.
    botRunId: uuid("bot_run_id").references(() => botRuns.id),
  },
  (table) => [
    index("orders_account_created_idx").on(table.accountId, table.createdAt),
    // Used by the background worker that processes pending limit orders.
    index("orders_status_symbol_idx").on(table.status, table.symbol),
    // Used by the bot worker to find every order belonging to one run (the
    // entry, the resting target, the eventual exit) without a table scan.
    index("orders_bot_run_idx").on(table.botRunId),
  ],
);

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  orderId: uuid("order_id").references(() => orders.id),
  kind: transactionKindEnum("kind").notNull(),
  // Signed: negative for buys, positive for sells and deposits.
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  balanceAfterCents: bigint("balance_after_cents", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A local, searchable copy of Alpaca's tradable-assets list - Alpaca has no
// search-by-name endpoint, only a bulk list, so this table is what search
// actually queries. Never a gate on trading itself: fetching a live quote
// always goes straight to Alpaca regardless of what's in here, so a symbol
// missing or stale in this table only ever degrades search/discovery, never
// the ability to trade something Alpaca still accepts.
export const assets = pgTable("assets", {
  symbol: text("symbol").primaryKey(),
  name: text("name").notNull(),
  exchange: text("exchange").notNull(),
  // Not deleted when Alpaca stops returning a symbol (delisted, deactivated)
  // - a position or watchlist entry can still legitimately reference it.
  // Instead this flips to false and lastSeenAt stops advancing, so the row
  // stays as a historical record instead of silently disappearing.
  tradable: boolean("tradable").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
});

// Append-only log, not a single mutable "last synced at" field - mirrors
// how orders/transactions record history here rather than overwriting it.
// Lets staleness detection tell "no successful sync in 30 days" apart from
// "syncs have been failing every day for 30 days" - very different problems
// that a single timestamp column can't distinguish.
export const assetSyncRuns = pgTable("asset_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: assetSyncStatusEnum("status").notNull().default("running"),
  assetCount: integer("asset_count"),
  errorMessage: text("error_message"),
});

// Same append-only run-log shape as assetSyncRuns, for the same reason: a
// single mutable "last run at" column can't tell "hasn't run in 20 minutes
// because nothing's scheduled it" apart from "has been failing every
// invocation for 20 minutes" - very different problems for the
// observability route (see app/api/worker/status/route.ts) to distinguish.
// marketWasOpen records which branch of the worker ran (the fill-checking
// branch vs. the closed-market expire-sweep) - the two do very different
// work, and a run's own counts only make sense read alongside which one it
// was.
export const limitOrderWorkerRuns = pgTable("limit_order_worker_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: limitOrderWorkerRunStatusEnum("status").notNull().default("running"),
  marketWasOpen: boolean("market_was_open"),
  ordersEvaluated: integer("orders_evaluated"),
  ordersFilled: integer("orders_filled"),
  ordersExpired: integer("orders_expired"),
  errorMessage: text("error_message"),
});

// Same append-only run-log shape as limitOrderWorkerRuns, for the same
// reason: without this, a bot_worker_runs-shaped fact simply doesn't exist
// anywhere - runSelectionCycle/runMonitoringCycle (lib/db/bot-runs.ts) write
// nothing to the database at all when there's no selecting/holding bot_runs
// row to act on, which is the common case. That means "the scheduled
// worker is silently no longer firing" and "the worker is firing and
// correctly finding nothing to do" were, before this table existed,
// indistinguishable from inside this app - both looked like silence. Every
// invocation writes a row here regardless of whether it found any bot_runs
// to act on, specifically so that distinction becomes answerable (see
// app/api/worker/bot-status/route.ts). The five *count columns mirror
// BotWorkerCounts (lib/db/bot-runs.ts) exactly, not a subset - a run log
// that couldn't show the full shape the route itself already returns would
// be a strictly worse observability tool than just reading the workflow's
// own logged response.
export const botWorkerRuns = pgTable("bot_worker_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: botWorkerRunStatusEnum("status").notNull().default("running"),
  runsConsideredForSelection: integer("runs_considered_for_selection"),
  runsEntered: integer("runs_entered"),
  runsFailedNoAffordableCandidate: integer("runs_failed_no_affordable_candidate"),
  runsMonitored: integer("runs_monitored"),
  runsClosed: integer("runs_closed"),
  errorMessage: text("error_message"),
});

export const watchlistItems = pgTable(
  "watchlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    symbol: text("symbol").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One star per (account, symbol) - toggling star on an already-watched
  // symbol removes it rather than erroring, but the constraint is what makes
  // that upsert-or-delete logic safe against a double-click race.
  (table) => [uniqueIndex("watchlist_items_account_symbol_idx").on(table.accountId, table.symbol)],
);
