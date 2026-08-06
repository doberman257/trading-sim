"use server";

import { revalidatePath } from "next/cache";
import { getOrCreateAccount } from "@/lib/db/accounts";
import { toggleWatchlistItem } from "@/lib/db/watchlist";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SymbolSchema } from "@/lib/trading/symbol";

export async function toggleWatchlist(rawSymbol: string): Promise<{ watched: boolean }> {
  const symbol = SymbolSchema.parse(rawSymbol);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error("Not authenticated");
  }

  const account = await getOrCreateAccount(user.id);
  const result = await toggleWatchlistItem(account.id, symbol);

  revalidatePath("/discover");
  revalidatePath(`/stock/${symbol}`);

  return result;
}
