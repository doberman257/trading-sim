import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedUserId } from "@/lib/auth/session";
import { placeLimitOrder } from "@/lib/db/orders";
import { SymbolSchema } from "@/lib/trading/symbol";

// A Route Handler, not a Server Action wrapped in one - deliberately, so a
// future bot with an API key can place a limit order the exact same way a
// browser session does, by calling this endpoint directly. A Server
// Action can only ever be invoked through this app's own generated action
// reference from inside a React tree; it has no meaning to an external
// client. If a Server Action for this is ever added, it should call this
// route (a thin client of it), not the other way around.
export const dynamic = "force-dynamic";

// Cents cross this boundary as a numeric string, not a JSON number - same
// reasoning as every other money value crossing a serialization boundary
// in this app (see OrderTicket's cashCentsString): a JSON number is an
// IEEE-754 float, and a large or fractional-looking value silently losing
// precision on the way in is exactly the class of bug this app's "money is
// always bigint" rule exists to prevent.
const CentsStringSchema = z
  .string()
  .regex(/^\d+$/, "limitPriceCents must be a positive integer string, in cents")
  .transform((value) => BigInt(value))
  .refine((value) => value > 0n, { message: "limitPriceCents must be greater than zero" });

const PlaceLimitOrderBodySchema = z.object({
  symbol: SymbolSchema,
  side: z.enum(["buy", "sell"]),
  quantity: z.number().int().positive(),
  limitPriceCents: CentsStringSchema,
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

  const parsed = PlaceLimitOrderBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: z.treeifyError(parsed.error) }, { status: 400 });
  }

  const { symbol, side, quantity, limitPriceCents } = parsed.data;

  const result = await placeLimitOrder({
    userId: auth.userId,
    symbol,
    side,
    quantity,
    limitPriceCents,
  });

  if (result.ok) {
    // Neither page has a server-side cache of its own to invalidate (see
    // app/actions/trade.ts's identical comment) - this clears the
    // client-side Router Cache so the new pending order shows up next time
    // either page is viewed.
    revalidatePath("/dashboard");
    revalidatePath(`/stock/${symbol}`);
    return NextResponse.json({ ok: true, orderId: result.orderId }, { status: 201 });
  }

  // A well-formed order that couldn't be accepted (insufficient funds/
  // shares, an invalid limit price) is a normal outcome, not a client
  // error about the request's shape - 422, not 400, to keep that
  // distinction visible to anything inspecting the status code alone
  // (a monitoring dashboard, a bot's generic HTTP error handling) without
  // needing to parse the body first.
  return NextResponse.json({ ok: false, reason: result.reason }, { status: 422 });
}
