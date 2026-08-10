import { NextResponse } from "next/server";
import { getLastLimitOrderWorkerRun } from "@/lib/db/limit-order-worker";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isMarketOpen } from "@/lib/trading/market-hours";
import {
  isWorkerRunStale,
  STALE_THRESHOLD_MS_WHEN_CLOSED,
  STALE_THRESHOLD_MS_WHEN_OPEN,
} from "@/lib/trading/worker-staleness";

// Auth-gated the same way /api/check-db is, not a bearer secret like the
// worker invocation route itself - a person checking this in a browser
// already has a session; there's no scheduler/bot reason to hit this one
// without a user in the loop, so the existing session pattern is the
// "lightest approach" rather than a second secret to manage.
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
  const lastRun = await getLastLimitOrderWorkerRun();

  if (!lastRun) {
    return NextResponse.json({
      hasEverRun: false,
      marketOpen,
      abnormal: true,
      reasons: ["The limit-order worker has never run."],
    });
  }

  const msSinceLastRun = now.getTime() - lastRun.startedAt.getTime();
  const threshold = marketOpen ? STALE_THRESHOLD_MS_WHEN_OPEN : STALE_THRESHOLD_MS_WHEN_CLOSED;
  const isStale = isWorkerRunStale(msSinceLastRun, marketOpen);
  const lastRunFailed = lastRun.status === "failed";
  // "running" long past when it should have finished means the process
  // most likely crashed or was killed mid-run, rather than genuinely still
  // being in progress - a single invocation processing at most
  // MAX_ORDERS_PER_RUN orders should never take anywhere near this long.
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
      marketWasOpen: lastRun.marketWasOpen,
      ordersEvaluated: lastRun.ordersEvaluated,
      ordersFilled: lastRun.ordersFilled,
      ordersExpired: lastRun.ordersExpired,
      errorMessage: lastRun.errorMessage,
    },
    msSinceLastRun,
    abnormal: reasons.length > 0,
    reasons,
  });
}
