import {
  bigint,
  boolean,
  index,
  integer,
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
  },
  (table) => [
    index("orders_account_created_idx").on(table.accountId, table.createdAt),
    // Used by the background worker that processes pending limit orders.
    index("orders_status_symbol_idx").on(table.status, table.symbol),
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
