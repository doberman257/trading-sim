import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Captured once, when this module is first evaluated - which on Vercel
// means once per cold start of a serverless function instance, not once
// per request. A warm invocation reuses the same module (and therefore the
// same `db` client from lib/db/client.ts) without re-running this line, so
// comparing this to "now" on each request is direct evidence of whether
// THIS invocation is running on a fresh instance or a reused warm one -
// exactly the thing that can't be observed from a local Docker Postgres,
// where there's no serverless instance lifecycle to begin with.
const moduleLoadedAt = new Date();

// Auth-gated rather than a shared secret: this project already has a real
// sign-in system, and "protected, not public" doesn't require a second
// credential to manage - anyone who can sign in can hit this, which is fine
// for a paper-trading demo app with one real user checking their own
// deploy. If this ever needs to run from a script/cron without a browser
// session, switch to a bearer secret compared against a new env var instead.
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const requestReceivedAt = new Date();
  const msSinceModuleLoad = requestReceivedAt.getTime() - moduleLoadedAt.getTime();

  const checks: Record<string, unknown> = {};
  let ok = true;

  try {
    const basic = await db.execute(sql`select 1 as ok`);
    checks.basicQuery = { ok: basic[0]?.ok === 1 };
  } catch (error) {
    ok = false;
    checks.basicQuery = { ok: false, error: String(error) };
  }

  try {
    const info = await db.execute(
      sql`select current_setting('server_version') as version, inet_server_port() as backend_port`,
    );
    const backendPort = info[0]?.backend_port;
    // DATABASE_URL's own port never appears in this response - it isn't
    // secret exactly, but there's no reason to echo connection details back
    // over an HTTP response. The backend-reported port is enough: Supabase's
    // pooler always terminates client connections on 6543, so if Postgres
    // itself reports a *different* port, something (pgbouncer) is sitting
    // between this app and Postgres - a direct connection would report the
    // same port back.
    checks.backendPort = {
      serverVersion: info[0]?.version,
      backendReportedPort: backendPort,
      proxied: String(backendPort) !== "6543",
    };
  } catch (error) {
    ok = false;
    checks.backendPort = { error: String(error) };
  }

  try {
    const echoValue = `check-db-${requestReceivedAt.getTime()}`;
    const parameterized = await db.execute(sql`select ${echoValue}::text as echoed`);
    checks.parameterizedQuery = { ok: parameterized[0]?.echoed === echoValue };
  } catch (error) {
    ok = false;
    checks.parameterizedQuery = { ok: false, error: String(error) };
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      await tx.execute(sql`select 2`);
    });
    checks.transaction = { ok: true };
  } catch (error) {
    ok = false;
    checks.transaction = { ok: false, error: String(error) };
  }

  return NextResponse.json({
    ok,
    checks,
    instance: {
      moduleLoadedAt: moduleLoadedAt.toISOString(),
      requestReceivedAt: requestReceivedAt.toISOString(),
      msSinceModuleLoad,
      // A rough heuristic, not a guarantee: a cold start's module evaluation
      // happens milliseconds before this handler runs, so a small gap here
      // means "probably cold"; a large one means "definitely warm, this
      // instance and its db client have been reused across invocations."
      likelyWarmInvocation: msSinceModuleLoad > 5000,
    },
  });
}
