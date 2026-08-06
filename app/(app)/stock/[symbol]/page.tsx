import { notFound, redirect } from "next/navigation";
import { MarketStatusBanner } from "@/components/MarketStatusBanner";
import { OrderTicket } from "@/components/OrderTicket";
import { StockChart } from "@/components/StockChart";
import { StockHeader } from "@/components/StockHeader";
import { StockPositionSummary } from "@/components/StockPositionSummary";
import { StockQuoteCard } from "@/components/StockQuoteCard";
import { getOrCreateAccount } from "@/lib/db/accounts";
import { getAssetBySymbol } from "@/lib/db/assets";
import { getPosition } from "@/lib/db/portfolio";
import { isSymbolWatched } from "@/lib/db/watchlist";
import { fetchDailyBars, fetchQuotes } from "@/lib/market/alpaca";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getMarketStatus } from "@/lib/trading/market-hours";
import { SymbolSchema } from "@/lib/trading/symbol";

// Live quotes must never be served from a cached snapshot of this page -
// see the caching rules in CLAUDE.md.
export const dynamic = "force-dynamic";

type StockPageProps = {
  params: Promise<{ symbol: string }>;
};

export default async function StockPage({ params }: StockPageProps) {
  const { symbol: rawSymbol } = await params;
  const parsedSymbol = SymbolSchema.safeParse(rawSymbol);

  if (!parsedSymbol.success) {
    notFound();
  }

  const symbol = parsedSymbol.data;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const account = await getOrCreateAccount(user.id);

  const [assetInfo, { quotes }, position, watched, dailyBars] = await Promise.all([
    getAssetBySymbol(symbol),
    fetchQuotes([symbol]),
    getPosition(account.id, symbol),
    isSymbolWatched(account.id, symbol),
    fetchDailyBars(symbol),
  ]);

  const quote = quotes.get(symbol) ?? null;
  const marketStatus = getMarketStatus(new Date());
  const isStale = !marketStatus.open;

  return (
    <main className="bg-base min-h-screen p-3">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <MarketStatusBanner status={marketStatus} />
        <StockHeader
          symbol={symbol}
          name={assetInfo?.name ?? null}
          exchange={assetInfo?.exchange ?? null}
          initialWatched={watched}
        />

        {/* Two distinct, non-alarming-vs-alarming signals about our local
            asset cache - neither blocks trading, both just explain what the
            page below already shows. See lib/db/assets.ts. */}
        {assetInfo === null && quote !== null && (
          <p className="text-subtle text-xs">
            {symbol} isn&apos;t in our stock list yet, though Alpaca has a live price for it - the
            asset sync may be overdue.
          </p>
        )}
        {assetInfo?.tradable === false && (
          <p className="text-warn text-xs">
            {symbol} is marked no-longer-tradable in our records (delisted or deactivated).
          </p>
        )}

        <StockQuoteCard
          symbol={symbol}
          bidCents={quote?.bidCents ?? null}
          askCents={quote?.askCents ?? null}
          isStale={isStale}
        />

        <StockChart
          bars={dailyBars.map((bar) => ({
            date: bar.date,
            openCents: bar.openCents.toString(),
            highCents: bar.highCents.toString(),
            lowCents: bar.lowCents.toString(),
            closeCents: bar.closeCents.toString(),
          }))}
        />

        {position ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[320px_1fr]">
            <OrderTicket
              cashCentsString={account.cashCents.toString()}
              heldPositions={[{ symbol, quantity: position.quantity }]}
              marketStatus={marketStatus}
              fixedSymbol={symbol}
            />
            <StockPositionSummary
              quantity={position.quantity}
              avgCostCents={position.avgCostCents}
              bidCents={quote?.bidCents ?? null}
            />
          </div>
        ) : (
          <div className="max-w-[320px]">
            <OrderTicket
              cashCentsString={account.cashCents.toString()}
              heldPositions={[]}
              marketStatus={marketStatus}
              fixedSymbol={symbol}
            />
          </div>
        )}
      </div>
    </main>
  );
}
