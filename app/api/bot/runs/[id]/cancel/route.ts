import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth/session";
import { cancelBotRun, type CancelBotRunResult } from "@/lib/db/bot-runs";

// A Route Handler, not a Server Action - same reasoning as every other bot
// route (see app/api/bot/runs/route.ts): a future bot-configuring client
// should be able to cancel a run the same way a browser session does.
export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ id: string }>;
};

// realizedPnlCents crosses the Server -> Client boundary as a string, same
// convention as every other money value in this app - NextResponse.json
// can't serialize a bigint at all (it throws), not just "shouldn't".
function serializeResult(result: CancelBotRunResult) {
  if (result.ok) {
    return result.status === "cancelled"
      ? result
      : { ...result, realizedPnlCents: result.realizedPnlCents.toString() };
  }
  if (result.reason === "already_closed") {
    return { ...result, realizedPnlCents: result.realizedPnlCents?.toString() ?? null };
  }
  return result;
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const auth = await getAuthenticatedUserId(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;

  const result = await cancelBotRun(auth.userId, id, new Date());

  // The run's real state may have changed even on a "loss" (the worker
  // entered or closed it out from under this attempt) - worth refreshing
  // either way, not just on a clean success.
  revalidatePath("/dashboard");

  if (result.ok) {
    return NextResponse.json(serializeResult(result), { status: 200 });
  }

  // Distinct outcomes, not one generic error - see CancelBotRunReason.
  // "already_entered"/"already_closed"/"already_resolved" are all the
  // outcome of a genuine race this app expects to happen, not something to
  // retry or treat as a server error.
  const status = result.reason === "not_found" ? 404 : 409;
  return NextResponse.json(serializeResult(result), { status });
}
