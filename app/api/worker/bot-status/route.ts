import { NextResponse } from "next/server";
import { getLastBotWorkerRun } from "@/lib/db/bot-runs";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isMarketOpen } from "@/lib/trading/market-hours";
import {
  isWorkerRunStale,
  STALE_THRESHOLD_MS_WHEN_CLOSED,
  STALE_THRESHOLD_MS_WHEN_OPEN,
} from "@/lib/trading/worker-staleness";

// Mirrors app/api/worker/status/route.ts's shape and staleness-threshold
// logic as closely as makes sense - same session-cookie auth (not the
// worker's own bearer secret, for the same reason: a person checking this
// in a browser already has a session), same isWorkerRunStale/threshold
// pair reused directly rather than re-derived (the bot worker runs on the
// exact same */5 * * * * cadence as the limit-order worker, so the same
// thresholds genuinely apply, not just structurally). The one real
// difference is the payload shape: bot_worker_runs' five *count columns
// (BotWorkerCounts, lib/db/bot-runs.ts) instead of the limit-order
// worker's marketWasOpen/ordersEvaluated/ordersFilled/ordersExpired.
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const now = new Date();
  const marketOpen = isMarketOpen(now);
  const lastRun = await getLastBotWorkerRun();

  if (!lastRun) {
    return NextResponse.json({
      hasEverRun: false,
      marketOpen,
      abnormal: true,
      reasons: ["The bot worker has never run."],
    });
  }

  const msSinceLastRun = now.getTime() - lastRun.startedAt.getTime();
  const threshold = marketOpen ? STALE_THRESHOLD_MS_WHEN_OPEN : STALE_THRESHOLD_MS_WHEN_CLOSED;
  const isStale = isWorkerRunStale(msSinceLastRun, marketOpen);
  const lastRunFailed = lastRun.status === "failed";
  // "running" long past when it should have finished means the process
  // most likely crashed or was killed mid-run, rather than genuinely still
  // being in progress - a single invocation (a bounded watchlist scan) has
  // no reason to take anywhere near this long.
  const lastRunStuck = lastRun.status === "running" && isStale;

  const reasons = [
    isStale
      ? `Last run started ${Math.round(msSinceLastRun / 60_000)} minutes ago, past the ` +
        `${marketOpen ? "market-open" : "market-closed"} threshold of ` +
        `${Math.round(threshold / 60_000)} minutes.`
      : null,
    lastRunFailed
      ? `Last run failed: ${lastRun.errorMessage ?? "no error message recorded"}.`
      : null,
    lastRunStuck
      ? 'Last run\'s status is still "running" well past when it should have finished - it may have crashed mid-run.'
      : null,
  ].filter((reason): reason is string => reason !== null);

  return NextResponse.json({
    hasEverRun: true,
    marketOpen,
    lastRun: {
      startedAt: lastRun.startedAt.toISOString(),
      finishedAt: lastRun.finishedAt?.toISOString() ?? null,
      status: lastRun.status,
      counts: {
        runsConsideredForSelection: lastRun.runsConsideredForSelection,
        runsEntered: lastRun.runsEntered,
        runsFailedNoAffordableCandidate: lastRun.runsFailedNoAffordableCandidate,
        runsMonitored: lastRun.runsMonitored,
        runsClosed: lastRun.runsClosed,
      },
      errorMessage: lastRun.errorMessage,
    },
    msSinceLastRun,
    abnormal: reasons.length > 0,
    reasons,
  });
}
