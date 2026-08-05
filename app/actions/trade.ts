"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { placeMarketOrder } from "@/lib/db/orders";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SymbolSchema } from "@/lib/trading/symbol";
import type { OrderResult } from "@/lib/trading/types";

const TradeInputSchema = z.object({
  symbol: SymbolSchema,
  side: z.enum(["buy", "sell"]),
  quantity: z.number().int().positive(),
});

export type TradeInput = z.input<typeof TradeInputSchema>;

export async function placeTrade(input: TradeInput): Promise<OrderResult> {
  const { symbol, side, quantity } = TradeInputSchema.parse(input);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error("Not authenticated");
  }

  const result = await placeMarketOrder({ userId: user.id, symbol, side, quantity });

  if (result.ok) {
    // The dashboard has no server-side cache of its own to invalidate (see
    // the caching note on app/dashboard/page.tsx) - this clears the
    // client-side Router Cache so a rejected order never needs this, but a
    // filled one is immediately reflected the next time the user navigates
    // back to the dashboard, once an order ticket calls this action there.
    revalidatePath("/dashboard");
  }

  return result;
}
