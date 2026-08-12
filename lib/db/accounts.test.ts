import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuote } from "../market/alpaca";
import { toCents } from "../trading/money";
import { getOrCreateAccount, resetAccount } from "./accounts";
import { db } from "./client";
import { placeLimitOrder, placeMarketOrder } from "./orders";
import { accounts, botRuns, orders, positions, transactions, watchlistItems } from "./schema";
import { assertLedgerBalances } from "./test-helpers";
import { toggleWatchlistItem } from "./watchlist";

vi.mock("../market/alpaca", () => ({ fetchQuote: vi.fn() }));
vi.mock("../trading/market-hours", () => ({ isMarketOpen: () => true }));

beforeEach(async () => {
  vi.mocked(fetchQuote).mockReset();
  await db.execute(
    sql`truncate table transactions, orders, positions, bot_runs, watchlist_items, accounts, limit_order_worker_runs cascade`,
  );
});

describe("resetAccount", () => {
  it("wipes orders, transactions, positions, and bot runs, and restores the starting balance", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    vi.mocked(fetchQuote).mockResolvedValue({
      symbol: "AAPL",
      bidCents: toCents("99.00"),
      askCents: toCents("100.00"),
      timestamp: new Date(),
    });
    const fill = await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 10 });
    if (!fill.ok) throw new Error("setup failed");

    const limit = await placeLimitOrder({
      userId,
      symbol: "MSFT",
      side: "buy",
      quantity: 1,
      limitPriceCents: toCents("1.00"),
    });
    expect(limit.ok).toBe(true);

    await db.insert(botRuns).values({
      accountId: account.id,
      status: "selecting",
      ruleId: "rsi_pullback_uptrend_v1",
      ruleParams: { rsiPeriod: 14 },
      capitalCents: toCents("500.00"),
      profitTargetType: "dollar",
      profitTargetValueCents: toCents("20.00"),
      stopLossType: "dollar",
      stopLossValueCents: toCents("20.00"),
    });

    const reset = await resetAccount(userId);

    expect(reset.cashCents).toBe(toCents("100000.00"));

    const remainingOrders = await db.select().from(orders).where(eq(orders.accountId, account.id));
    expect(remainingOrders).toHaveLength(0);

    const remainingPositions = await db
      .select()
      .from(positions)
      .where(eq(positions.accountId, account.id));
    expect(remainingPositions).toHaveLength(0);

    const remainingBotRuns = await db
      .select()
      .from(botRuns)
      .where(eq(botRuns.accountId, account.id));
    expect(remainingBotRuns).toHaveLength(0);

    const remainingTransactions = await db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, account.id));
    expect(remainingTransactions).toHaveLength(1);
    expect(remainingTransactions[0]?.kind).toBe("deposit");
    expect(remainingTransactions[0]?.amountCents).toBe(toCents("100000.00"));

    await assertLedgerBalances(account.id);
  });

  it("does not touch the watchlist", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    await toggleWatchlistItem(account.id, "AAPL");

    await resetAccount(userId);

    const watched = await db
      .select()
      .from(watchlistItems)
      .where(eq(watchlistItems.accountId, account.id));
    expect(watched).toHaveLength(1);
    expect(watched[0]?.symbol).toBe("AAPL");
  });

  it("keeps the same account row (same id), not a new account", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    const reset = await resetAccount(userId);

    expect(reset.id).toBe(account.id);
    const rows = await db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it("is a no-op-safe reset on a brand-new account with no history yet", async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);

    const reset = await resetAccount(userId);

    expect(reset.cashCents).toBe(toCents("100000.00"));
    await assertLedgerBalances(reset.id);
  });
});
