import { getMarketStatus } from "./market-hours";

// How long before the actual close a holding bot run force-exits, rather
// than waiting for the close itself. This has to be strictly before the
// close, not at or after it: executeMarketOrder rejects with
// "market_closed" once the market is actually shut, so a position that
// waited until then would be stuck open until the next session, not
// closed out. Set to twice the bot worker's own cycle cadence (5 minutes,
// matching the limit-order worker's schedule - see
// .github/workflows/limit-order-worker.yml) so a single missed or delayed
// tick still leaves one more chance to catch it before the close, given
// GitHub Actions' schedule is best-effort, not guaranteed to the minute.
export const DAY_EXPIRY_BUFFER_MS = 10 * 60 * 1000;

// True when the market is open right now but will close within the buffer
// window - the trigger for a holding bot run's day-order-expiry exit. Pure
// function of `now`, same "safe under irregular invocation" discipline as
// the limit-order worker: two checks a minute apart or an hour apart both
// give the correct answer for that instant, with no memory of when this
// was last checked.
export function isApproachingMarketClose(now: Date): boolean {
  const status = getMarketStatus(now);
  if (!status.open || !status.closesAt) {
    return false;
  }
  return status.closesAt.getTime() - now.getTime() <= DAY_EXPIRY_BUFFER_MS;
}
