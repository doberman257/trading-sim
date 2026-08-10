// How long is too long since the limit-order worker last even attempted a
// run, depending on whether the market is currently open - see
// .github/workflows/limit-order-worker.yml for the actual schedule this
// tracks. Deliberately a generous multiple of the real cron interval, not
// the interval itself: GitHub Actions' schedule trigger is documented as
// best-effort, not to-the-minute, so a single missed tick must not read as
// abnormal on its own - several missed ticks in a row should. Shared by
// app/api/worker/status/route.ts (the observability endpoint) and the
// dashboard/stock detail pages' own "is anyone watching my pending orders"
// signal, so both agree on the same threshold rather than each guessing.
export const STALE_THRESHOLD_MS_WHEN_OPEN = 20 * 60 * 1000; // 20 minutes
export const STALE_THRESHOLD_MS_WHEN_CLOSED = 24 * 60 * 60 * 1000; // 24 hours

export function isWorkerRunStale(msSinceLastRun: number, marketOpen: boolean): boolean {
  const threshold = marketOpen ? STALE_THRESHOLD_MS_WHEN_OPEN : STALE_THRESHOLD_MS_WHEN_CLOSED;
  return msSinceLastRun > threshold;
}
