import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

// A stand-in for `drizzle-kit push`, which currently crashes introspecting
// this database - see drizzle/0001_add_assets_and_sync_runs.sql for why.
// Applies a hand-written SQL file in one transaction so a failure partway
// through can't leave the schema half-migrated.
async function main(): Promise<void> {
  const file = process.argv[2];
  const connectionString =
    process.argv[3] === "test" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

  if (!file) {
    console.error("Usage: tsx scripts/apply-migration.ts <path-to-sql-file> [test]");
    process.exit(1);
  }

  if (!connectionString) {
    console.error("Missing DATABASE_URL (or TEST_DATABASE_URL with the 'test' argument).");
    process.exit(1);
  }

  const migrationSql = readFileSync(file, "utf-8");
  const sql = postgres(connectionString, { prepare: false });

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(migrationSql);
    });
    console.log(`Applied ${file} successfully.`);
  } catch (error) {
    console.error(`Failed to apply ${file}:`);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main();
