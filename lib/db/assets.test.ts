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

  // The real bug this guards against, confirmed against the live asset
  // table before fixing: "intel" is also a mid-word substring of
  // "intelligence", and the real table has ~30 tradable "Artificial
  // Intelligence"-branded funds - all of which used to outrank Intel
  // Corporation itself (whose name genuinely starts with "Intel") purely
  // by alphabetical symbol order within an undifferentiated "name contains
  // it somewhere" tier, pushing INTC to position 20 of a 20-row limit.
  it("ranks a name-prefix match above a name that merely contains the query mid-word", async () => {
    await seedAssets([
      { symbol: "AIFD", name: "TCW Artificial Intelligence ETF" },
      { symbol: "AIO", name: "Virtus Artificial Intelligence Fund" },
      { symbol: "INTC", name: "Intel Corporation Common Stock" },
    ]);

    const results = await searchAssets("intel");

    expect(results.map((r) => r.symbol)).toEqual(["INTC", "AIFD", "AIO"]);
  });

  it("still ranks a symbol match above a name-prefix match", async () => {
    await seedAssets([
      { symbol: "INTC", name: "Intel Corporation Common Stock" },
      { symbol: "INTEL", name: "Some Unrelated Fund" },
    ]);

    // The new name-prefix tier (2) must slot in below the existing symbol
    // tiers (0, 1), not ahead of them - INTEL's symbol is an exact match
    // for the query, which should still win over INTC's mere name-prefix
    // match even though INTC is the "real" company here.
    const results = await searchAssets("intel");

    expect(results.map((r) => r.symbol)).toEqual(["INTEL", "INTC"]);
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
