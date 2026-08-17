-- Written by hand for the real Supabase database, same reason as
-- 0001/0003/0004: `drizzle-kit push` reproducibly crashes introspecting
-- that database (drizzle-team/drizzle-orm#4496). NOT YET APPLIED to the
-- real database as of this commit - per this project's "don't touch prod
-- schema without asking" policy, this migration is ready but withheld
-- pending the user's explicit go-ahead. Applied locally via
-- `npm run db:push:test` (drizzle-kit push works fine against local test
-- Postgres) and confirmed via the integration suite.
--
-- Same append-only run-log shape as limit_order_worker_runs, modeled
-- directly on it (verified column-for-column against
-- 0003_add_limit_order_worker_runs.sql before writing this, not
-- reconstructed from memory) - the bot worker never had an equivalent
-- invocation log at all, which meant "the scheduled worker silently
-- stopped firing" and "the worker is firing and correctly finding nothing
-- to do" were indistinguishable from inside this app. Every invocation of
-- runBotWorker (lib/db/bot-runs.ts) now writes one row here regardless of
-- whether it found any bot_runs to act on. The five *count columns mirror
-- BotWorkerCounts exactly, not a subset.
CREATE TYPE "public"."bot_worker_run_status" AS ENUM ('running', 'succeeded', 'failed');

CREATE TABLE "public"."bot_worker_runs" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  "status" "public"."bot_worker_run_status" NOT NULL DEFAULT 'running',
  "runs_considered_for_selection" integer,
  "runs_entered" integer,
  "runs_failed_no_affordable_candidate" integer,
  "runs_monitored" integer,
  "runs_closed" integer,
  "error_message" text
);
