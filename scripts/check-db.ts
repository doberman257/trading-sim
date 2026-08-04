import { existsSync } from "node:fs";
import postgres from "postgres";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("Missing DATABASE_URL environment variable");
    process.exit(1);
  }

  const url = new URL(connectionString);
  const clientPort = url.port || "5432";

  console.log(`Connecting to ${url.hostname}:${clientPort}${url.pathname}`);
  console.log(
    clientPort === "6543"
      ? "Client port 6543: this looks like Supabase's connection pooler (pgbouncer, transaction mode)."
      : clientPort === "5432"
        ? "Client port 5432: this looks like a DIRECT connection, not the pooler. Vercel serverless " +
          "functions can exhaust direct connection slots under load - see lib/db/client.ts."
        : `Client port ${clientPort}: not a recognized Supabase port (5432 direct / 6543 pooler). ` +
          "Double check DATABASE_URL.",
  );

  // Same config lib/db/client.ts uses - this script exists to prove that
  // config actually works against the real database, not just typecheck.
  const sql = postgres(connectionString, { prepare: false });

  try {
    console.log("\n[1/4] plain query (SELECT 1)...");
    const basic = await sql`select 1 as ok`;
    if (basic[0]?.ok !== 1) {
      throw new Error(`Unexpected result from SELECT 1: ${JSON.stringify(basic)}`);
    }
    console.log("  ok");

    console.log("[2/4] server info + backend port (proxying signal)...");
    const info = await sql`
      select current_setting('server_version') as version, inet_server_port() as backend_port
    `;
    const backendPort = info[0]?.backend_port;
    console.log(`  server_version: ${info[0]?.version}`);
    console.log(`  backend_port:   ${backendPort}`);
    if (backendPort !== null && String(backendPort) !== clientPort) {
      console.log(
        `  -> client port (${clientPort}) differs from the backend's own port (${backendPort}): ` +
          "confirms a proxy (pgbouncer, or Docker port mapping) sits between this client and Postgres.",
      );
    } else {
      console.log(`  -> client port matches the backend port: connected directly to Postgres.`);
    }

    console.log("[3/4] parameterized query (schema-independent)...");
    const echoValue = `check-db-${Date.now()}`;
    const parameterized = await sql`select ${echoValue}::text as echoed`;
    if (parameterized[0]?.echoed !== echoValue) {
      throw new Error(
        `Parameter did not round-trip: sent "${echoValue}", got back ${JSON.stringify(parameterized[0])}`,
      );
    }
    console.log(`  ok: bound parameter round-tripped ("${echoValue}")`);

    console.log("[4/4] multiple sequential queries inside one transaction...");
    await sql.begin(async (tx) => {
      await tx`select 1`;
      await tx`select 2`;
      await tx`select ${echoValue}::text as echoed`;
    });
    console.log("  ok: transaction committed cleanly");

    console.log("\nSuccess: DATABASE_URL is reachable and works correctly with prepare: false.");
  } catch (error) {
    console.error("\nFAILED:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main();
