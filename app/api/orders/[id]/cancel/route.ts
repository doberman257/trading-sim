import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth/session";
import { cancelOrder } from "@/lib/db/orders";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ id: string }>;
};

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const auth = await getAuthenticatedUserId(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;

  const result = await cancelOrder(auth.userId, id);

  if (result.ok) {
    revalidatePath("/dashboard");
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // Distinct outcomes, not one generic error - see CancelOrderReason.
  // "already_filled" specifically is the outcome of a genuine race this
  // app expects to happen (this cancellation lost to the worker's own
  // claim on the same row lock) and must read as a real, informative
  // result to the caller, not an error to retry or a silent no-op.
  const status = result.reason === "not_found" ? 404 : 409;
  return NextResponse.json({ ok: false, reason: result.reason }, { status });
}
