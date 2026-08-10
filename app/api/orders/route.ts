import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/session";
import { getOrCreateAccount } from "@/lib/db/accounts";
import { getOrdersForAccount } from "@/lib/db/orders";

// The read counterpart to POST /api/orders/limit and POST
// /api/orders/[id]/cancel - same Route Handler reasoning: a future
// API-key-authenticated bot needs a way to check its own orders that
// doesn't involve parsing session-gated, HTML-rendering Server Components.
// Same auth pattern (getAuthenticatedUserId) as the write side.
export const dynamic = "force-dynamic";

const ORDER_STATUSES = ["pending", "filled", "cancelled", "rejected", "expired"] as const;
const StatusQuerySchema = z.enum(ORDER_STATUSES).optional();

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthenticatedUserId(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status") ?? undefined;
  const parsedStatus = StatusQuerySchema.safeParse(rawStatus);

  if (!parsedStatus.success) {
    return NextResponse.json(
      {
        error: `Invalid status filter "${rawStatus}". Must be one of: ${ORDER_STATUSES.join(", ")}.`,
      },
      { status: 400 },
    );
  }

  const account = await getOrCreateAccount(auth.userId);
  const orders = await getOrdersForAccount(account.id, { status: parsedStatus.data });

  // Cents cross this boundary as numeric strings, never a raw bigint -
  // NextResponse.json calls JSON.stringify under the hood, which throws
  // outright on a bigint, so this isn't just this app's usual convention
  // here, it's the difference between a response and a crash.
  return NextResponse.json({
    orders: orders.map((order) => ({
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      status: order.status,
      limitPriceCents: order.limitPriceCents?.toString() ?? null,
      filledPriceCents: order.filledPriceCents?.toString() ?? null,
      rejectReason: order.rejectReason,
      createdAt: order.createdAt.toISOString(),
      filledAt: order.filledAt?.toISOString() ?? null,
    })),
  });
}
