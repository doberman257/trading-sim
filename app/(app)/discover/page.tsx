import { redirect } from "next/navigation";
import { AssetSyncNotice } from "@/components/AssetSyncNotice";
import { PopularStocksPanel } from "@/components/PopularStocksPanel";
import { StockSearch } from "@/components/StockSearch";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import { getOrCreateAccount } from "@/lib/db/accounts";
import { getLastSuccessfulAssetSync } from "@/lib/db/assets";
import { getWatchlist } from "@/lib/db/watchlist";
import { fetchDailyBarsForSymbols, fetchQuotes } from "@/lib/market/alpaca";
import { POPULAR_SYMBOLS } from "@/lib/market/popular-symbols";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Live quotes must never be served from a cached snapshot of this page - see
// the caching rules in CLAUDE.md - and the sync-staleness notice below is
// itself time-sensitive (it says how many days ago), so this can't be static.
export const dynamic = "force-dynamic";

export default async function DiscoverPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const account = await getOrCreateAccount(user.id);
  const watchlist = await getWatchlist(account.id);

  const watchlistSymbols = watchlist.map((entry) => entry.symbol);
  const popularSymbols = POPULAR_SYMBOLS.map((entry) => entry.symbol);

  // Sparklines are watchlist-only (not Popular, which is fixed curated
  // content, not something a user is tracking) and batched into one request
  // for the whole list rather than one per symbol - see
  // fetchDailyBarsForSymbols in lib/market/alpaca.ts.
  const [{ quotes }, lastSuccessfulSync, sparklineBars] = await Promise.all([
    fetchQuotes([...watchlistSymbols, ...popularSymbols]),
    getLastSuccessfulAssetSync(),
    fetchDailyBarsForSymbols(watchlistSymbols),
  ]);

  const watchlistItems = watchlist.map((entry) => {
    const quote = quotes.get(entry.symbol);
    const bars = sparklineBars.get(entry.symbol) ?? [];
    return {
      symbol: entry.symbol,
      name: entry.name,
      bidCents: quote?.bidCents ?? null,
      askCents: quote?.askCents ?? null,
      sparklineCloses: bars.map((bar) => bar.closeCents),
    };
  });

  const popularItems = POPULAR_SYMBOLS.map((entry) => {
    const quote = quotes.get(entry.symbol);
    return {
      symbol: entry.symbol,
      name: entry.name,
      bidCents: quote?.bidCents ?? null,
      askCents: quote?.askCents ?? null,
    };
  });

  return (
    <main className="bg-base min-h-screen p-3">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-3">
        <h1 className="text-fg text-lg font-medium">Discover</h1>
        <StockSearch />
        <AssetSyncNotice lastSuccessfulSync={lastSuccessfulSync} now={new Date()} />
        {/* Only shown once populated - an empty watchlist panel here has
            nothing useful to say that Popular below doesn't already cover. */}
        {watchlistItems.length > 0 && <WatchlistPanel items={watchlistItems} />}
        <PopularStocksPanel items={popularItems} />
      </div>
    </main>
  );
}
