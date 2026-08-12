import { NextResponse } from "next/server";
import { isAuthorizedWorkerRequest } from "@/lib/auth/worker-secret";
import { runBotWorker } from "@/lib/db/bot-runs";

// Same shape as app/api/worker/limit-orders/route.ts, deliberately - a
// second worker route, not an extension of the first, since bot runs and
// limit orders are different lifecycles with different cadences to watch
// (a resting limit order only needs a price check; a bot run also needs
// stop-loss/day-expiry/rule-exit evaluated against fresh bars, not just a
// quote). Reuses the same bearer-secret auth and VERCEL_ENV guard rather
// than inventing new ones - there is still only one real database, and a
// preview deployment racing the real scheduled worker against it is
// exactly the risk that guard exists to prevent, regardless of which
// worker it is.
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv && vercelEnv !== "production") {
    return NextResponse.json(
      { error: `Bot worker is disabled outside production (VERCEL_ENV=${vercelEnv})` },
      { status: 403 },
    );
  }

  if (!isAuthorizedWorkerRequest(req)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  const outcome = await runBotWorker(new Date());

  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: outcome.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...outcome.counts }, { status: 200 });
}
