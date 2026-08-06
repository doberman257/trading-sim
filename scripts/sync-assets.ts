import { existsSync } from "node:fs";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

// Dynamic, not a top-level import: lib/db/assets.ts pulls in lib/db/client.ts,
// which reads DATABASE_URL at module load time - a static import would be
// hoisted above the .env.local loading above and always see it as missing.
async function main(): Promise<void> {
  const { syncAssets } = await import("../lib/db/assets");
  const result = await syncAssets();

  if (!result.ok) {
    console.error(`Asset sync failed: ${result.error}`);
    process.exit(1);
  }

  console.log(
    `Synced ${result.assetCount} tradable assets. ` +
      `${result.markedStaleCount} previously-tradable asset(s) marked no-longer-tradable.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
