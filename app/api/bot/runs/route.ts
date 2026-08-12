import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/session";
import { createBotRun, getBotRunsForAccount, runBotWorker } from "@/lib/db/bot-runs";
import { getOrCreateAccount } from "@/lib/db/accounts";
import type { TargetConfig } from "@/lib/trading/bot-targets";

// A Route Handler, not a Server Action - same reasoning as
// app/api/orders/limit/route.ts: a future bot-configuring client should be
// able to start/list its own bot runs the exact same way a browser session
// does, by calling this endpoint directly.
export const dynamic = "force-dynamic";

const CentsStringSchema = z
  .string()
  .regex(/^\d+$/, "must be a positive integer string, in cents")
  .transform((value) => BigInt(value))
  .refine((value) => value > 0n, { message: "must be greater than zero" });

const TargetConfigSchema = z.union([
  z.object({ type: z.literal("dollar"), valueCents: CentsStringSchema }),
  z.object({ type: z.literal("percent"), basisPoints: z.number().int().positive() }),
]);

const CreateBotRunBodySchema = z.object({
  capitalCents: CentsStringSchema,
  profitTarget: TargetConfigSchema,
  stopLoss: TargetConfigSchema,
  // ISO string, or omitted for "no earlier deadline than the rule's own
  // day-order expiry" - see lib/db/schema.ts's own note on what null means
  // here.
  timeHorizonDeadlineAt: z.string().datetime().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await getAuthenticatedUserId(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CreateBotRunBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: z.treeifyError(parsed.error) }, { status: 400 });
  }

  const { capitalCents, profitTarget, stopLoss, timeHorizonDeadlineAt } = parsed.data;

  const result = await createBotRun({
    userId: auth.userId,
    capitalCents,
    profitTarget: profitTarget as TargetConfig,
    stopLoss: stopLoss as TargetConfig,
    timeHorizonDeadlineAt: timeHorizonDeadlineAt ? new Date(timeHorizonDeadlineAt) : null,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 422 });
  }

  // Runs one selection cycle immediately, for faster feedback than waiting
  // for the next scheduled worker tick (not yet scheduled at all - see
  // STATE.md) - a caller choice made here, not something createBotRun does
  // on its own. Best-effort: if this throws (a real Alpaca outage, say),
  // the run still exists in "selecting" and a later manual worker
  // invocation will pick it up, so the failure is swallowed rather than
  // turned into a 500 for what was otherwise a successful creation.
  try {
    await runBotWorker(new Date());
  } catch {
    // Swallowed deliberately - see the comment above.
  }

  revalidatePath("/dashboard");
  return NextResponse.json({ ok: true, runId: result.runId }, { status: 201 });
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthenticatedUserId(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const account = await getOrCreateAccount(auth.userId);
  const runs = await getBotRunsForAccount(account.id);

  return NextResponse.json({
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      ruleId: run.ruleId,
      capitalCents: run.capitalCents.toString(),
      selectedSymbol: run.selectedSymbol,
      entryTotalCents: run.entryTotalCents?.toString() ?? null,
      entryQuantity: run.entryQuantity,
      realizedPnlCents: run.realizedPnlCents?.toString() ?? null,
      createdAt: run.createdAt.toISOString(),
      closedAt: run.closedAt?.toISOString() ?? null,
    })),
  });
}
