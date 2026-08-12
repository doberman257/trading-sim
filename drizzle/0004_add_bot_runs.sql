-- Written by hand for the real Supabase database, same reason as
-- 0001/0003: `drizzle-kit push` reproducibly crashes introspecting that
-- database (drizzle-team/drizzle-orm#4496), confirmed again on this schema
-- change's own local-vs-real divergence pattern before writing this file.
-- NOT YET APPLIED to the real database as of this commit - per this
-- project's "don't touch prod schema without asking" policy, this migration
-- is ready but withheld pending the user's explicit go-ahead, the same
-- sequencing 0003 followed. Applied locally via `npm run db:push:test`
-- (drizzle-kit push works fine against local test Postgres).
--
-- bot_runs must be created before the ALTER TABLE on orders below, since
-- orders.bot_run_id references it.
CREATE TYPE "public"."bot_run_status" AS ENUM (
  'selecting',
  'holding',
  'closed_stop_loss',
  'closed_day_expiry',
  'closed_target',
  'closed_rule_exit',
  'failed_no_affordable_candidate'
);

CREATE TYPE "public"."bot_target_type" AS ENUM ('dollar', 'percent');

CREATE TABLE "public"."bot_runs" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "public"."accounts"("id"),
  "status" "public"."bot_run_status" NOT NULL DEFAULT 'selecting',
  "rule_id" text NOT NULL,
  "rule_params" jsonb NOT NULL,
  "capital_cents" bigint NOT NULL,
  "profit_target_type" "public"."bot_target_type" NOT NULL,
  "profit_target_value_cents" bigint,
  "profit_target_basis_points" integer,
  "stop_loss_type" "public"."bot_target_type" NOT NULL,
  "stop_loss_value_cents" bigint,
  "stop_loss_basis_points" integer,
  "time_horizon_deadline_at" timestamp with time zone,
  "selected_symbol" text,
  "entry_total_cents" bigint,
  "entry_quantity" integer,
  "realized_pnl_cents" bigint,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "closed_at" timestamp with time zone
);

ALTER TABLE "public"."orders" ADD COLUMN "bot_run_id" uuid REFERENCES "public"."bot_runs"("id");

CREATE INDEX "orders_bot_run_idx" ON "public"."orders" ("bot_run_id");
