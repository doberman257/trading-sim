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
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });

export type DbTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
