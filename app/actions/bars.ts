"use server";

import { fetchBars, type BarTimeframe } from "@/lib/market/alpaca";
import { RANGE_LOOKBACK_MS, type ChartRange } from "@/lib/market/chart-timeframes";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SymbolSchema } from "@/lib/trading/symbol";

export type BarDto = {
  timestamp: string;
  openCents: string;
  highCents: string;
  lowCents: string;
  closeCents: string;
  volume: number;
};

// A Server Action is a public endpoint regardless of which page calls it -
// same reasoning as getQuoteForSymbol - so this still checks auth even
// though bar history isn't user-specific data. Called both for the stock
// detail page's initial render and again, client-side, whenever the user
// changes the chart's timeframe or range - fetchBars' own completed/live
// cache split (lib/market/alpaca.ts) is what keeps repeated calls for the
// same timeframe cheap, not anything this action does itself.
export async function getBarsForSymbol(
  rawSymbol: string,
  timeframe: BarTimeframe,
  range: ChartRange,
): Promise<BarDto[]> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  const parsed = SymbolSchema.safeParse(rawSymbol);
  if (!parsed.success) {
    return [];
  }

  const bars = await fetchBars(parsed.data, timeframe, RANGE_LOOKBACK_MS[range]);

  return bars.map((bar) => ({
    timestamp: bar.timestamp,
    openCents: bar.openCents.toString(),
    highCents: bar.highCents.toString(),
    lowCents: bar.lowCents.toString(),
    closeCents: bar.closeCents.toString(),
    volume: bar.volume,
  }));
}
