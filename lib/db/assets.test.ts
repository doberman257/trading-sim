import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./client";
import { getLastSuccessfulAssetSync, searchAssets } from "./assets";
import { assetSyncRuns, assets } from "./schema";

beforeEach(async () => {
  await db.execute(sql`truncate table asset_sync_runs, assets cascade`);
});

async function seedAssets(rows: { symbol: string; name: string; tradable?: boolean }[]) {
  await db.insert(assets).values(
    rows.map((row) => ({
      symbol: row.symbol,
      name: row.name,
      exchange: "NASDAQ",
      tradable: row.tradable ?? true,
      lastSeenAt: new Date(),
    })),
  );
}

describe("searchAssets", () => {
  it("returns nothing for a blank query", async () => {
    await seedAssets([{ symbol: "AAPL", name: "Apple Inc" }]);

    expect(await searchAssets("   ")).toEqual([]);
  });

  it("matches by symbol substring, case-insensitively", async () => {
    await seedAssets([
      { symbol: "AAPL", name: "Apple Inc" },
      { symbol: "TSLA", name: "Tesla Inc" },
    ]);

    const results = await searchAssets("aap");

    expect(results).toEqual([{ symbol: "AAPL", name: "Apple Inc", exchange: "NASDAQ" }]);
  });

  it("matches by company name substring", async () => {
    await seedAssets([
      { symbol: "AAPL", name: "Apple Inc" },
      { symbol: "TSLA", name: "Tesla Inc" },
    ]);

    const results = await searchAssets("tesla");

    expect(results).toEqual([{ symbol: "TSLA", name: "Tesla Inc", exchange: "NASDAQ" }]);
  });

  it("ranks an exact symbol match above a longer symbol containing the same text", async () => {
    await seedAssets([
      { symbol: "AAPL", name: "Apple Inc" },
      { symbol: "AAPLX", name: "Some Apple-Adjacent Fund" },
    ]);

    const results = await searchAssets("AAPL");

    expect(results.map((r) => r.symbol)).toEqual(["AAPL", "AAPLX"]);
  });

  it("ranks a symbol-prefix match above a name-only match", async () => {
    await seedAssets([
      { symbol: "ZZZ", name: "App Zeta Corp" },
      { symbol: "APPX", name: "Appian Exchange" },
    ]);

    const results = await searchAssets("app");

    expect(results.map((r) => r.symbol)).toEqual(["APPX", "ZZZ"]);
  });

  it("excludes assets that are no longer tradable", async () => {
    await seedAssets([{ symbol: "DEAD", name: "Defunct Co", tradable: false }]);

    expect(await searchAssets("dead")).toEqual([]);
  });
});

describe("getLastSuccessfulAssetSync", () => {
  it("returns null when no sync has ever succeeded", async () => {
    expect(await getLastSuccessfulAssetSync()).toBeNull();
  });

  it("returns the most recent succeeded run's finishedAt, ignoring failed runs", async () => {
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-01-02T00:00:00Z");

    await db.insert(assetSyncRuns).values([
      { status: "succeeded", finishedAt: older, assetCount: 100 },
      { status: "failed", finishedAt: new Date("2026-01-03T00:00:00Z"), errorMessage: "boom" },
      { status: "succeeded", finishedAt: newer, assetCount: 101 },
    ]);

    expect(await getLastSuccessfulAssetSync()).toEqual(newer);
  });
});
