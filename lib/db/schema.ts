import {
  bigint,
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
]);
export const transactionKindEnum = pgEnum("transaction_kind", ["deposit", "buy", "sell"]);

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
