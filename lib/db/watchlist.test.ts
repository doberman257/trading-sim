import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getOrCreateAccount } from "./accounts";
import { db } from "./client";
import { assets } from "./schema";
import { getWatchlist, isSymbolWatched, toggleWatchlistItem } from "./watchlist";

beforeEach(async () => {
  await db.execute(sql`truncate table watchlist_items, assets, accounts cascade`);
});

describe("toggleWatchlistItem", () => {
  it("adds a symbol that isn't currently watched", async () => {
    const account = await getOrCreateAccount(randomUUID());

    const result = await toggleWatchlistItem(account.id, "AAPL");

    expect(result).toEqual({ watched: true });
    expect(await isSymbolWatched(account.id, "AAPL")).toBe(true);
  });

  it("removes a symbol that is currently watched", async () => {
    const account = await getOrCreateAccount(randomUUID());
    await toggleWatchlistItem(account.id, "AAPL");

    const result = await toggleWatchlistItem(account.id, "AAPL");

    expect(result).toEqual({ watched: false });
    expect(await isSymbolWatched(account.id, "AAPL")).toBe(false);
  });

  it("keeps watchlists scoped per account", async () => {
    const accountA = await getOrCreateAccount(randomUUID());
    const accountB = await getOrCreateAccount(randomUUID());

    await toggleWatchlistItem(accountA.id, "AAPL");

    expect(await isSymbolWatched(accountA.id, "AAPL")).toBe(true);
    expect(await isSymbolWatched(accountB.id, "AAPL")).toBe(false);
  });
});

describe("getWatchlist", () => {
  it("returns an empty list for an account that has starred nothing", async () => {
    const account = await getOrCreateAccount(randomUUID());

    expect(await getWatchlist(account.id)).toEqual([]);
  });

  it("resolves each symbol's name from the assets table, alphabetically by symbol", async () => {
    const account = await getOrCreateAccount(randomUUID());
    await db.insert(assets).values([
      {
        symbol: "TSLA",
        name: "Tesla, Inc.",
        exchange: "NASDAQ",
        tradable: true,
        lastSeenAt: new Date(),
      },
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NASDAQ",
        tradable: true,
        lastSeenAt: new Date(),
      },
    ]);
    await toggleWatchlistItem(account.id, "TSLA");
    await toggleWatchlistItem(account.id, "AAPL");

    expect(await getWatchlist(account.id)).toEqual([
      { symbol: "AAPL", name: "Apple Inc." },
      { symbol: "TSLA", name: "Tesla, Inc." },
    ]);
  });

  it("falls back to the bare symbol when the assets table has no matching row", async () => {
    const account = await getOrCreateAccount(randomUUID());
    await toggleWatchlistItem(account.id, "ZZZZ");

    expect(await getWatchlist(account.id)).toEqual([{ symbol: "ZZZZ", name: "ZZZZ" }]);
  });
});
