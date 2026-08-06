"use server";

import { searchAssets, type AssetSearchResult } from "@/lib/db/assets";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// A Server Action is a public endpoint regardless of which page calls it -
// same reasoning as getQuoteForSymbol - so this still checks auth even
// though search results aren't user-specific data.
export async function searchStocks(query: string): Promise<AssetSearchResult[]> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  return searchAssets(query);
}
