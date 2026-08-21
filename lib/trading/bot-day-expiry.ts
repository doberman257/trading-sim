import { maxHoldDays, type BotRuleParams } from "./bot-rule";
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

// The real close timestamp a "same-day" deadline is measured against, used
// by createBotRun (lib/db/bot-runs.ts) to reject a custom
// timeHorizonDeadlineAt later than rsi_pullback's own same-day cap. Not
// just "today's calendar date" - if the market is closed right now (the
// common case: a run can be created at any hour), the applicable boundary
// is the NEXT session's own close, since that's the earliest close a
// same-day-capped run could actually be subject to. Calling
// getMarketStatus a second time, at the moment status.nextOpen itself
// reports, is what finds that - the same "ask the pure function for the
// answer instead of re-deriving a day-boundary rule by hand" discipline
// isApproachingMarketClose already follows.
export function nextApplicableCloseTime(now: Date): Date {
  const status = getMarketStatus(now);
  if (status.open && status.closesAt) {
    return status.closesAt;
  }
  const nextSessionStatus = getMarketStatus(status.nextOpen);
  if (!nextSessionStatus.open || !nextSessionStatus.closesAt) {
    throw new Error(
      "getMarketStatus(nextOpen) did not report the market open - this should be impossible",
    );
  }
  return nextSessionStatus.closesAt;
}

// The earliest of the strategy's own maxHoldDays cap (measured from the
// REAL entry date, not a creation-time estimate) and a user's own earlier
// explicit deadline - always the SOONER of the two, so a user's own choice
// can only pull an exit earlier, never override the strategy's real cap.
// createBotRun's own validation (lib/db/bot-runs.ts) already keeps a
// user's deadline no later than a creation-time ESTIMATE of this cap (the
// real entry date doesn't exist yet then), but a run that sits "selecting"
// for a while before actually entering could still end up with a stored
// deadline looser than the TRUE entry-based cap by the time it matters -
// this is what closes that gap for real, at evaluation time, not just at
// creation time. Returns null only when neither applies: no cap for this
// rule family (rsi_pullback) AND no user-chosen deadline - same-day close
// (isApproachingMarketClose) is the only boundary that applies then,
// unchanged from before this function existed.
export function effectiveDeadline(
  kind: BotRuleParams["kind"],
  entryFilledAt: Date | null,
  userDeadline: Date | null,
): Date | null {
  const days = maxHoldDays(kind);
  const strategyDeadline =
    days !== null && entryFilledAt !== null
      ? new Date(entryFilledAt.getTime() + days * 24 * 60 * 60 * 1000)
      : null;

  if (userDeadline !== null && strategyDeadline !== null) {
    return userDeadline.getTime() <= strategyDeadline.getTime() ? userDeadline : strategyDeadline;
  }
  return userDeadline ?? strategyDeadline;
}
