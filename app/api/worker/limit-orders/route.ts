import { NextResponse } from "next/server";
import { isAuthorizedWorkerRequest } from "@/lib/auth/worker-secret";
import { runLimitOrderWorker } from "@/lib/db/limit-order-worker";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // Blocks this route outside a real production deployment. This app's
  // preview/development deployments (if any) point at the same real
  // Supabase database described in the README - there's only one, not one
  // per environment - so a preview build's copy of this route must never
  // be allowed to actually run the worker: two independently-scheduled or
  // accidentally-triggered instances racing to claim the same pending
  // orders against the same real data is exactly the kind of bug this
  // guard exists to make impossible rather than merely unlikely.
  // VERCEL_ENV is unset entirely outside Vercel's own infrastructure (a
  // local dev server, CI), which is deliberately NOT blocked here - only
  // an explicit non-production Vercel environment is.
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv && vercelEnv !== "production") {
    return NextResponse.json(
      { error: `Limit order worker is disabled outside production (VERCEL_ENV=${vercelEnv})` },
      { status: 403 },
    );
  }

  if (!isAuthorizedWorkerRequest(req)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  const outcome = await runLimitOrderWorker(new Date());

  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: outcome.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...outcome.counts }, { status: 200 });
}
