import { redirect } from "next/navigation";
import { BotRunForm } from "@/components/BotRunForm";
import { BotRunsPanel } from "@/components/BotRunsPanel";
import { BotStatsPanel } from "@/components/BotStatsPanel";
import { MarketStatusBanner } from "@/components/MarketStatusBanner";
import { OrderTicket } from "@/components/OrderTicket";
import { PendingOrdersPanel } from "@/components/PendingOrdersPanel";
import { PortfolioAllocation } from "@/components/PortfolioAllocation";
import { PositionsPanel } from "@/components/PositionsPanel";
import { RecentOrdersPanel } from "@/components/RecentOrdersPanel";
import { SummaryPanel } from "@/components/SummaryPanel";
import { getOrCreateAccount } from "@/lib/db/accounts";
import { getBotRunsForAccount } from "@/lib/db/bot-runs";
import { getBotRuleStatsForAccount } from "@/lib/db/bot-stats";
import { getLastLimitOrderWorkerRun } from "@/lib/db/limit-order-worker";
import { getPendingOrdersForAccount } from "@/lib/db/orders";
import { getPortfolio } from "@/lib/db/portfolio";
import { fetchDailyBarsForSymbols, fetchQuotes } from "@/lib/market/alpaca";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { calculateAllocation } from "@/lib/trading/allocation";
import { getMarketStatus } from "@/lib/trading/market-hours";
import { calculatePortfolio } from "@/lib/trading/portfolio";
import { isWorkerRunStale } from "@/lib/trading/worker-staleness";

// This page reads the user's session via cookies() (inside
// createSupabaseServerClient), which already forces dynamic rendering on
// its own - `force-dynamic` here is belt-and-suspenders so that stays true
// even if the auth call above it ever changes, given the hard rule that
// market data must never be served from a cached snapshot of this page.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Lazily provisions the account on first visit - no separate signup step.
  const account = await getOrCreateAccount(user.id);
  const portfolio = await getPortfolio(account.id);

  const symbols = portfolio.positions.map((position) => position.symbol);
  // fetchQuotes never throws for market-data failures (see lib/market/alpaca.ts):
  // an Alpaca outage and a single bad symbol both come back as failedSymbols,
  // so calculatePortfolio below treats them identically to "no quote available".
  // fetchDailyBarsForSymbols batches every held symbol's sparkline data into
  // one request rather than one per position - see lib/market/alpaca.ts.
  // getPendingOrdersForAccount/getLastLimitOrderWorkerRun feed the pending-
  // orders panel and its staleness signal below - fetched here, not inside
  // that Client Component, since this Server Component already loads
  // everything else the page needs in one place.
  const [{ quotes }, sparklineBars, pendingOrders, lastWorkerRun, botRuns, botRuleStats] =
    await Promise.all([
      fetchQuotes(symbols),
      fetchDailyBarsForSymbols(symbols),
      getPendingOrdersForAccount(account.id),
      getLastLimitOrderWorkerRun(),
      getBotRunsForAccount(account.id),
      getBotRuleStatsForAccount(account.id),
    ]);
  const sparklines = new Map(
    [...sparklineBars.entries()].map(([symbol, bars]) => [
      symbol,
      bars.map((bar) => bar.closeCents),
    ]),
  );

  const marketStatus = getMarketStatus(new Date());
  const valuation = calculatePortfolio(portfolio.positions, portfolio.cashCents, quotes);
  const allocation = calculateAllocation(
    valuation.positions,
    portfolio.cashCents,
    valuation.totalEquityCents,
  );

  // Never let a user believe a pending order is being actively watched if
  // it might not be - see lib/trading/worker-staleness.ts. "Never run at
  // all" counts as stale, the same as a run that happened too long ago.
  const workerStale =
    !lastWorkerRun ||
    isWorkerRunStale(Date.now() - lastWorkerRun.startedAt.getTime(), marketStatus.open);

  // Prices are only ever live immediately after a fresh fetch while the
  // market is open. There is no quote cache in this app for an individual
  // quote to go stale within (see the caching notes in lib/market/alpaca.ts
  // and this route's `force-dynamic`), so "the market is closed" is the one
  // real source of a last-close, not-live price on this page.
  const isStale = !marketStatus.open;

  return (
    <main className="bg-base min-h-screen p-3">
      {/* Widened past the usual max-w-6xl: the panel grid below genuinely
          needs it - see the trading-ui-design skill's Panel grid
          proportions note for the column-width math behind this number. */}
      <div className="mx-auto flex max-w-[1600px] flex-col gap-3">
        <MarketStatusBanner status={marketStatus} />
        <SummaryPanel
          cashCents={portfolio.cashCents}
          totalEquityCents={valuation.totalEquityCents}
          totalUnrealizedPnlCents={valuation.totalUnrealizedPnlCents}
          missingQuoteSymbols={valuation.missingQuoteSymbols}
        />
        <PortfolioAllocation slices={allocation} />
        {/* 320px fixed for the order ticket (a form, not content that grows);
            the two data panels split the rest 3:2 - Positions has 6 columns
            including a wide signed P&L-with-percent column, Recent orders
            has 6 columns but every value is shorter. See the design skill's
            Panel grid proportions note. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[320px_3fr_2fr]">
          <OrderTicket
            cashCentsString={portfolio.cashCents.toString()}
            heldPositions={portfolio.positions}
            marketStatus={marketStatus}
          />
          <PositionsPanel
            positions={valuation.positions}
            isStale={isStale}
            sparklines={sparklines}
          />
          <RecentOrdersPanel orders={portfolio.recentOrders} />
        </div>
        <PendingOrdersPanel
          orders={pendingOrders.map((order) => ({
            id: order.id,
            symbol: order.symbol,
            side: order.side,
            quantity: order.quantity,
            limitPriceCents: order.limitPriceCents.toString(),
          }))}
          workerStale={workerStale}
        />
        {/* Autonomous bot: config form, this account's own runs, and the
            rule-level stats view - grouped together since they're all part
            of the same feature, below everything else on the page (a
            standing feature, not the main trading workflow). The bot
            worker itself isn't scheduled yet (see STATE.md) - a run starts
            "selecting" and is picked up either by the one immediate cycle
            the create route triggers or the next manual worker invocation. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[320px_1fr]">
          <BotRunForm />
          <BotRunsPanel
            runs={botRuns.map((run) => ({
              id: run.id,
              status: run.status,
              ruleId: run.ruleId,
              capitalCents: run.capitalCents.toString(),
              selectedSymbol: run.selectedSymbol,
              entryTotalCents: run.entryTotalCents?.toString() ?? null,
              entryQuantity: run.entryQuantity,
              realizedPnlCents: run.realizedPnlCents?.toString() ?? null,
              createdAt: run.createdAt.toISOString(),
              closedAt: run.closedAt?.toISOString() ?? null,
            }))}
          />
        </div>
        <BotStatsPanel stats={botRuleStats} />
      </div>
    </main>
  );
}
