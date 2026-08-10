-- Applied by hand via scripts/apply-migration.ts, not `drizzle-kit push` -
-- the same unpatched upstream introspection bug documented in
-- 0001_add_assets_and_sync_runs.sql (drizzle-team/drizzle-orm#4496)
-- reproduces against this database again, confirmed with the exact same
-- crash (`checkValue.replace` on undefined) when re-attempting `db:push`
-- for this change specifically.
--
-- Two independent changes, both needed for limit orders to work against
-- this database: the "expired" status a day order gets swept to at market
-- close, and the worker's own append-only run log
-- (limit_order_worker_runs), modeled directly on asset_sync_runs (same
-- table, verified against information_schema.columns on this database
-- before writing this) - the one existing table with the identical
-- shape (a run log with started_at/finished_at/status/counts/error).
--
-- ALTER TYPE ... ADD VALUE is run in its own statement, not combined with
-- anything that uses the new value - Postgres forbids using an enum value
-- added earlier in the same transaction, and this migration never inserts
-- an "expired" row itself (only the worker does, later, in its own
-- transaction).
ALTER TYPE "public"."order_status" ADD VALUE 'expired';

CREATE TYPE "public"."limit_order_worker_run_status" AS ENUM ('running', 'succeeded', 'failed');

CREATE TABLE "public"."limit_order_worker_runs" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  "status" "public"."limit_order_worker_run_status" NOT NULL DEFAULT 'running',
  "market_was_open" boolean,
  "orders_evaluated" integer,
  "orders_filled" integer,
  "orders_expired" integer,
  "error_message" text
);
