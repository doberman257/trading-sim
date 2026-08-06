-- Applied by hand via scripts/apply-migration.ts, not `drizzle-kit push`.
--
-- `drizzle-kit push` crashes introspecting this database specifically: a
-- foreign key gets misclassified as a check constraint and it calls
-- .replace() on an undefined value. Confirmed as an existing, unpatched
-- drizzle-kit bug (drizzle-team/drizzle-orm#4496), reproduced identically
-- against the real Supabase database and NOT reproduced against a fresh
-- local Postgres with the same schema - something about how Supabase
-- represents these constraints triggers it, not anything specific to this
-- app's schema. `db:push:test` (local Postgres) still works fine; `db:push`
-- against the real database does not, until upstream ships a fix.
--
-- Column types and defaults below were verified against this database's
-- existing tables (information_schema.columns on accounts/orders) so this
-- matches exactly what drizzle-kit would have generated.
CREATE TYPE "public"."asset_sync_status" AS ENUM ('running', 'succeeded', 'failed');

CREATE TABLE "public"."assets" (
  "symbol" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "exchange" text NOT NULL,
  "tradable" boolean NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL
);

CREATE TABLE "public"."asset_sync_runs" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  "status" "public"."asset_sync_status" NOT NULL DEFAULT 'running',
  "asset_count" integer,
  "error_message" text
);
