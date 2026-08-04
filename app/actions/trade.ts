"use server";

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

  return placeMarketOrder({ userId: user.id, symbol, side, quantity });
}
