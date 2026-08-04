import { existsSync } from "node:fs";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

// Runs before lib/db/client.ts is ever imported by a test, so the `db`
// singleton it exports connects to the test database instead of DATABASE_URL.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Missing TEST_DATABASE_URL. Start the test database (docker compose -f docker-compose.test.yml up -d), " +
      "push the schema (npm run db:push:test), then set TEST_DATABASE_URL before running npm run test:integration.",
  );
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
