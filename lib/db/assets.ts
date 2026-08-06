import { and, eq, ilike, lt, or, sql } from "drizzle-orm";
import { fetchTradableAssets } from "../market/alpaca";
import { db } from "./client";
import { assetSyncRuns, assets } from "./schema";

// drizzle-orm has no first-class helper for referencing `excluded.<column>`
// (Postgres's standard way to read the row that was about to be inserted,
// from inside an ON CONFLICT clause) - `sql.raw` on a fixed, code-controlled
// column name (never user input) is the documented workaround.
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

// Alpaca's own active-us_equity list runs well over 10,000 - a suspiciously
// small response is far more likely a bad/truncated fetch than a genuine
// market-wide delisting event. Guarding on this before touching the table
// is what stops a bad response from marking thousands of real assets stale.
const MIN_EXPECTED_ASSET_COUNT = 1000;

// Postgres caps bind parameters per statement at 65535; each row here binds
// 5 columns, so batches must stay comfortably under 65535 / 5. Chunking
// also keeps each individual statement's lock/log footprint small.
const UPSERT_BATCH_SIZE = 1000;

export type SyncAssetsResult =
  { ok: true; assetCount: number; markedStaleCount: number } | { ok: false; error: string };

// Idempotent: re-running this with no upstream changes leaves the table
// (and the sync-run log) in exactly the same state - every asset gets the
// same upsert, and nothing new falls outside the "seen this run" set to be
// marked stale.
export async function syncAssets(): Promise<SyncAssetsResult> {
  const [run] = await db
    .insert(assetSyncRuns)
    .values({})
    .returning({ id: assetSyncRuns.id, startedAt: assetSyncRuns.startedAt });

  if (!run) {
    throw new Error("Failed to record a new asset_sync_runs row");
  }

  let fetched: Awaited<ReturnType<typeof fetchTradableAssets>>;
  try {
    fetched = await fetchTradableAssets();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markRunFailed(run.id, message);
    return { ok: false, error: message };
  }

  if (fetched.length < MIN_EXPECTED_ASSET_COUNT) {
    const message =
      `Alpaca returned only ${fetched.length} assets (expected at least ${MIN_EXPECTED_ASSET_COUNT}) - ` +
      `treating this as a failed sync rather than applying it.`;
    await markRunFailed(run.id, message);
    return { ok: false, error: message };
  }

  // A single "as of" timestamp for the whole run, not per-row wall-clock
  // time - every asset upserted by this run gets the exact same lastSeenAt,
  // which is what makes "not touched by this run" an unambiguous check.
  const asOf = run.startedAt;
  let markedStaleCount = 0;

  try {
    await db.transaction(async (tx) => {
      for (let i = 0; i < fetched.length; i += UPSERT_BATCH_SIZE) {
        const batch = fetched.slice(i, i + UPSERT_BATCH_SIZE);
        await tx
          .insert(assets)
          .values(
            batch.map((asset) => ({
              symbol: asset.symbol,
              name: asset.name,
              exchange: asset.exchange,
              tradable: asset.tradable,
              lastSeenAt: asOf,
            })),
          )
          .onConflictDoUpdate({
            target: assets.symbol,
            set: {
              name: sqlExcluded("name"),
              exchange: sqlExcluded("exchange"),
              tradable: sqlExcluded("tradable"),
              lastSeenAt: sqlExcluded("last_seen_at"),
            },
          });
      }

      // Not deleted, not silently left behind: anything still marked
      // tradable from a previous run but not touched by this one is no
      // longer in Alpaca's active list - flip it so search/discovery stops
      // surfacing it, while a position or watchlist entry can still resolve
      // the symbol's name.
      const staleRows = await tx
        .update(assets)
        .set({ tradable: false })
        .where(and(lt(assets.lastSeenAt, asOf), eq(assets.tradable, true)))
        .returning({ symbol: assets.symbol });

      markedStaleCount = staleRows.length;
    });
  } catch (error) {
    // Without this, a failure partway through the upsert would leave this
    // run's row stuck at status "running" forever instead of "failed" -
    // indistinguishable from a process that crashed before ever finishing,
    // which defeats the append-only log's whole purpose of telling "never
    // synced" apart from "failing repeatedly."
    const message = error instanceof Error ? error.message : String(error);
    await markRunFailed(run.id, message);
    return { ok: false, error: message };
  }

  await db
    .update(assetSyncRuns)
    .set({ status: "succeeded", finishedAt: new Date(), assetCount: fetched.length })
    .where(eq(assetSyncRuns.id, run.id));

  return { ok: true, assetCount: fetched.length, markedStaleCount };
}

async function markRunFailed(runId: string, message: string): Promise<void> {
  await db
    .update(assetSyncRuns)
    .set({ status: "failed", finishedAt: new Date(), errorMessage: message })
    .where(eq(assetSyncRuns.id, runId));
}

// Last successful run's completion time, or null if there has never been
// one - the one fact the UI needs to answer "how stale is this list."
export async function getLastSuccessfulAssetSync(): Promise<Date | null> {
  const [latest] = await db
    .select({ finishedAt: assetSyncRuns.finishedAt })
    .from(assetSyncRuns)
    .where(eq(assetSyncRuns.status, "succeeded"))
    .orderBy(sql`${assetSyncRuns.finishedAt} desc`)
    .limit(1);

  return latest?.finishedAt ?? null;
}

export type AssetInfo = {
  symbol: string;
  name: string;
  exchange: string;
  tradable: boolean;
};

// Null means "not in our local list" - a real, distinct outcome from
// tradable: false. It happens whenever the sync hasn't caught up on a
// symbol yet (a new listing, or one reached via the search escape hatch)
// and must never be presented as "this symbol doesn't exist" - Alpaca, not
// this table, is the actual authority on whether a symbol is real.
export async function getAssetBySymbol(symbol: string): Promise<AssetInfo | null> {
  const [row] = await db.select().from(assets).where(eq(assets.symbol, symbol));
  return row ?? null;
}

export type AssetSearchResult = {
  symbol: string;
  name: string;
  exchange: string;
};

const SEARCH_RESULT_LIMIT = 20;

// Alpaca has no search endpoint (see lib/market/alpaca.ts) - this is what
// every symbol/name lookup in the app actually queries. Benchmarked directly
// against the real ~14,200-row table: a plain ILIKE seq scan runs in well
// under 100ms, comfortably inside typing-speed budgets, so no trigram index
// was added - revisit only if the table grows by an order of magnitude.
//
// Delisted assets (tradable = false) are excluded: surfacing a symbol here
// that would immediately fail at Alpaca is worse than not finding it, and a
// position or watchlist entry that already references a delisted symbol
// resolves its name by direct lookup, not through search.
export async function searchAssets(query: string): Promise<AssetSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const pattern = `%${trimmed}%`;
  const prefixPattern = `${trimmed}%`;
  const upperTrimmed = trimmed.toUpperCase();

  const rows = await db
    .select({ symbol: assets.symbol, name: assets.name, exchange: assets.exchange })
    .from(assets)
    .where(
      and(
        eq(assets.tradable, true),
        or(ilike(assets.symbol, pattern), ilike(assets.name, pattern)),
      ),
    )
    // Exact symbol match first, then symbol-prefix match, then everything
    // else alphabetically - so searching "AAPL" surfaces AAPL above a longer
    // symbol or a company name that merely contains the substring.
    .orderBy(
      sql`case
        when ${assets.symbol} = ${upperTrimmed} then 0
        when ${assets.symbol} ilike ${prefixPattern} then 1
        else 2
      end`,
      assets.symbol,
    )
    .limit(SEARCH_RESULT_LIMIT);

  return rows;
}
