import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { assets, watchlistItems } from "./schema";

export type WatchlistEntry = {
  symbol: string;
  // Falls back to the symbol itself if the assets table has no row for it
  // (e.g. the sync hasn't run since this symbol was added) - a watchlist
  // entry never disappears or breaks just because the local asset cache is
  // behind, since watching a symbol never depended on it being in that table
  // to begin with.
  name: string;
};

export async function getWatchlist(accountId: string): Promise<WatchlistEntry[]> {
  const rows = await db
    .select({ symbol: watchlistItems.symbol, name: assets.name })
    .from(watchlistItems)
    .leftJoin(assets, eq(assets.symbol, watchlistItems.symbol))
    .where(eq(watchlistItems.accountId, accountId))
    .orderBy(watchlistItems.symbol);

  return rows.map((row) => ({ symbol: row.symbol, name: row.name ?? row.symbol }));
}

export async function isSymbolWatched(accountId: string, symbol: string): Promise<boolean> {
  const [row] = await db
    .select({ id: watchlistItems.id })
    .from(watchlistItems)
    .where(and(eq(watchlistItems.accountId, accountId), eq(watchlistItems.symbol, symbol)));

  return row !== undefined;
}

// Delete-then-insert, not a read-check-then-write: deleting first and
// checking how many rows it removed is itself the "is this currently
// watched" check, so there's no separate read that a concurrent toggle could
// invalidate before the write happens. onConflictDoNothing on the insert
// covers the remaining race (two toggles landing as two inserts) without
// needing the row-lock machinery lib/db/orders.ts uses for money - a
// watchlist star being briefly inconsistent under a double-click has no
// financial consequence. Wrapped in a transaction per CLAUDE.md's "every
// database write happens inside a transaction" rule, applying unconditionally
// even though the add path is the only one that runs two statements.
export async function toggleWatchlistItem(
  accountId: string,
  symbol: string,
): Promise<{ watched: boolean }> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(watchlistItems)
      .where(and(eq(watchlistItems.accountId, accountId), eq(watchlistItems.symbol, symbol)))
      .returning({ id: watchlistItems.id });

    if (deleted.length > 0) {
      return { watched: false };
    }

    await tx.insert(watchlistItems).values({ accountId, symbol }).onConflictDoNothing();
    return { watched: true };
  });
}
