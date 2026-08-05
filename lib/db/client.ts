import "server-only";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsTransaction } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing DATABASE_URL environment variable");
}

// This must be Supabase's connection pooler URL (port 6543, pgbouncer in
// transaction mode), not the direct connection (port 5432). Vercel's
// serverless functions each open their own connections; the direct endpoint
// runs out of slots quickly under concurrent invocations.
//
// PgBouncer's transaction pooling hands a request a Postgres connection only
// for the duration of one transaction, then returns it to the pool for reuse
// by other clients. A prepared statement lives on the underlying Postgres
// connection, not on the pgbouncer session, so a statement prepared during
// one transaction may be gone (or worse, collide with a different prepared
// statement of the same name from another client) the next time this code
// runs. `prepare: false` makes postgres.js send plain, unprepared queries,
// which is what transaction-mode pooling requires.
//
// `max: 1` in production: this module-level `client` is one per warm
// serverless function instance, not one per request - it's meant to be
// reused across invocations on the same instance, which is correct and
// intentional, not a bug to "fix" by creating a fresh client per request.
// But postgres.js defaults `max` to 10 connections *per client*, and
// Vercel can run many instances concurrently under load - 10 connections
// x N concurrent instances can exhaust pgbouncer's own connection budget
// in a way that never shows up against a single local Postgres in dev or
// CI. Each real invocation only ever needs one connection at a time
// (nothing in this codebase runs two queries concurrently within a single
// request), so 1 is correct there, not just conservative.
//
// `DB_POOL_MAX` override exists ONLY for the integration test process: the
// row-lock concurrency test (lib/db/orders.test.ts) runs two
// `placeMarketOrder` calls concurrently through this SAME client, from one
// Node process, specifically to prove `SELECT ... FOR UPDATE` blocks a
// genuinely concurrent second transaction. At `max: 1`, postgres.js can
// only ever have one connection checked out at a time, so the second
// `db.transaction()` call would queue client-side until the first
// released its connection - the two transactions could never be
// in-flight on separate connections simultaneously, and the test would
// pass even with the lock deliberately removed (confirmed by testing
// exactly that). `vitest.integration.setup.ts` sets this to allow the
// second connection the test needs; nothing sets it in production, so
// deployed code always gets the strict default.
const client = postgres(connectionString, {
  prepare: false,
  max: process.env.DB_POOL_MAX ? Number(process.env.DB_POOL_MAX) : 1,
  idle_timeout: 20,
});

export const db = drizzle(client, { schema });

export type DbTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
