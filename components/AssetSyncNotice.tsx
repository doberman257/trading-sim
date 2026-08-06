import { describeAssetSyncStatus } from "./assetSyncMessages";

export type AssetSyncNoticeProps = {
  lastSuccessfulSync: Date | null;
  now: Date;
};

// Always rendered, never hidden even when things are fine - same philosophy
// as MarketStatusBanner: staleness the user can't see isn't staleness that
// gets fixed. Only "stale"/"never" get the louder warn treatment; "ok" is a
// quiet one-liner that doesn't compete for attention.
export function AssetSyncNotice({ lastSuccessfulSync, now }: AssetSyncNoticeProps) {
  const status = describeAssetSyncStatus(lastSuccessfulSync, now);

  if (status.level === "ok") {
    return <p className="text-subtle text-xs">{status.message}</p>;
  }

  return (
    <div className="border-warn/30 bg-warn/5 text-warn flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
      <span className="bg-warn size-1.5 rounded-full" />
      {status.message}
    </div>
  );
}
