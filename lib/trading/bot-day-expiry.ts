import { getMarketStatus } from "./market-hours";

// How long before the actual close a holding bot run force-exits, rather
// than waiting for the close itself. This has to be strictly before the
// close, not at or after it: executeMarketOrder rejects with
// "market_closed" once the market is actually shut, so a position that
// waited until then would be stuck open until the next session, not
// closed out.
//
// This used to be 10 minutes ("twice the bot worker's own cycle cadence
// (5 minutes)... so a single missed or delayed tick still leaves one more
// chance"), which assumed the schedule's own nominal `*/5 * * * *` cron
// expression was a reasonable stand-in for the REAL cadence. It wasn't:
// this bug let a real bot run (BMY, 2026-08-19/20 - see STATE.md's
// Gotchas) sit holding well past its own 4pm ET close undetected, into a
// genuinely accidental overnight hold that then got exposed to a second,
// separate bug (a bot-tagged resting order being swept by the OTHER
// worker's own day-expiry sweep - see limit-order-worker.ts). Measured
// directly against this app's own real bot_worker_runs history at the
// time of that investigation (103 real gaps between consecutive scheduled
// invocations, not a sample of a few): median 34.8 minutes, p90 58.7
// minutes, max 108.4 minutes - GitHub Actions' own "best-effort, not
// guaranteed to the minute" schedule note undersells just how loose the
// real cadence actually runs for this repo. 10 minutes was never a real
// safety margin against that; it was a safety margin against a cadence
// this app doesn't actually get.
//
// Reset using the SAME "twice the real cadence" methodology the original
// number used, just against the real p90 (not the nominal schedule): 2 x
// 58.7 =~ 117 minutes, rounded up to a clean 120. The real, deliberate
// trade-off this creates: isApproachingMarketClose now reads true for
// roughly the last third of a normal 6.5-hour trading session, not just
// the last few minutes before the bell - a much more aggressive "force
// this run closed" window than the original design intended, but a false
// "still fine" reading (a run silently surviving past the actual close
// again) is the worse failure mode of the two, given what it already
// caused once. If a future session ever finds the real measured cadence
// has genuinely improved (a different scheduler, GitHub Actions itself
// getting more reliable for this repo), that's a real reason to shrink
// this back down - re-measure against bot_worker_runs.startedAt gaps
// first, the same way this number was derived, not by assuming the
// nominal 5-minute schedule is trustworthy again.
export const DAY_EXPIRY_BUFFER_MS = 120 * 60 * 1000;

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
