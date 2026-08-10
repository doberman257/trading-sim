import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth/session";
import { getOrCreateAccount } from "@/lib/db/accounts";
import { getPortfolio } from "@/lib/db/portfolio";
import { fetchQuotes } from "@/lib/market/alpaca";
import { calculatePortfolio } from "@/lib/trading/portfolio";

// Same Route Handler reasoning as GET /api/orders: a bot needs to check
// its own cash/positions without parsing a session-gated dashboard page.
// Reuses the exact same pure valuation logic the dashboard itself calls
// (calculatePortfolio) rather than a parallel, potentially-drifting
// calculation - the API and the dashboard agree by construction, not by
// staying in sync manually.
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthenticatedUserId(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const account = await getOrCreateAccount(auth.userId);
  const portfolio = await getPortfolio(account.id);

  const symbols = portfolio.positions.map((position) => position.symbol);
  const { quotes } = await fetchQuotes(symbols);
  const valuation = calculatePortfolio(portfolio.positions, portfolio.cashCents, quotes);

  // Cents cross this boundary as numeric strings, never a raw bigint -
  // NextResponse.json's underlying JSON.stringify throws outright on a
  // bigint, so this isn't just convention here, it's the difference
  // between a response and a crash.
  return NextResponse.json({
    cashCents: portfolio.cashCents.toString(),
    totalMarketValueCents: valuation.totalMarketValueCents.toString(),
    totalEquityCents: valuation.totalEquityCents.toString(),
    totalUnrealizedPnlCents: valuation.totalUnrealizedPnlCents.toString(),
    // Present, not swallowed - a position with no live quote is excluded
    // from the totals above, not shown as zero, and a consumer needs this
    // list to know the totals are partial, same reasoning as the
    // dashboard's own SummaryPanel.
    missingQuoteSymbols: valuation.missingQuoteSymbols,
    positions: valuation.positions.map((position) => ({
      symbol: position.symbol,
      quantity: position.quantity,
      avgCostCents: position.avgCostCents.toString(),
      currentPriceCents: position.currentPriceCents?.toString() ?? null,
      marketValueCents: position.marketValueCents?.toString() ?? null,
      unrealizedPnlCents: position.unrealizedPnlCents?.toString() ?? null,
      unrealizedPnlPercent: position.unrealizedPnlPercent,
    })),
  });
}
