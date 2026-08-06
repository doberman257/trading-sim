// Kept in its own plain file, not inside AssetSyncNotice.tsx - same reasoning
// as orderMessages.ts: pure, no-DB-needed wording logic must stay importable
// by the default unit suite, which runs with zero environment variables (see
// vitest.config.ts). AssetSyncNotice.tsx itself stays a thin renderer.

// Below this many days since the last successful sync, staleness is worth
// mentioning but not alarming - the asset list still mostly reflects
// reality, it just might be missing the newest listings. Chosen because the
// sync is a manually-run script (see lib/db/assets.ts): a week of not
// running it is a normal gap, not a sign anything is broken.
const STALE_THRESHOLD_DAYS = 7;

export type AssetSyncStatus = {
  level: "ok" | "stale" | "never";
  message: string;
};

function daysSince(date: Date, now: Date): number {
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

// Exported so the exact wording is unit-testable without a DOM/render setup,
// same pattern as MarketStatusBanner's openMessage/closedMessage.
export function describeAssetSyncStatus(
  lastSuccessfulSync: Date | null,
  now: Date,
): AssetSyncStatus {
  if (!lastSuccessfulSync) {
    return {
      level: "never",
      message:
        "The stock list has never been synced — search and browsing may be missing recently listed stocks.",
    };
  }

  const days = daysSince(lastSuccessfulSync, now);

  if (days >= STALE_THRESHOLD_DAYS) {
    return {
      level: "stale",
      message: `Stock list last updated ${days} days ago — search may not reflect recent listings or delistings.`,
    };
  }

  if (days >= 1) {
    return { level: "ok", message: `Stock list updated ${days} day${days === 1 ? "" : "s"} ago.` };
  }

  return { level: "ok", message: "Stock list updated within the last day." };
}
