import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Missing DATABASE_URL environment variable");
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  // Without this, drizzle-kit introspects every schema in the database,
  // including Supabase's own (auth, storage, extensions, ...) - one of
  // those has a check constraint drizzle-kit's introspection can't parse
  // and crashes on. This app only ever manages the public schema anyway.
  schemaFilter: ["public"],
});
