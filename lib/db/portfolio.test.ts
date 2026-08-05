import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuote } from "../market/alpaca";
import { toCents } from "../trading/money";
import type { Quote } from "../trading/types";
import { getOrCreateAccount } from "./accounts";
import { db } from "./client";
import { placeMarketOrder } from "./orders";
import { getPortfolio } from "./portfolio";

vi.mock("../market/alpaca", () => ({
  fetchQuote: vi.fn(),
}));

vi.mock("../trading/market-hours", () => ({
  isMarketOpen: () => true,
}));

function mockQuote(overrides: Partial<Quote> = {}): Quote {
  const quote: Quote = {
    symbol: "AAPL",
    bidCents: toCents("99.00"),
    askCents: toCents("100.00"),
    timestamp: new Date(),
    ...overrides,
  };

  vi.mocked(fetchQuote).mockResolvedValue(quote);

  return quote;
}

beforeEach(async () => {
  vi.mocked(fetchQuote).mockReset();
  await db.execute(sql`truncate table transactions, orders, positions, accounts cascade`);
});

describe("getPortfolio", () => {
  it("returns cash, positions, and orders for a brand new account with none of either", async () => {
    const account = await getOrCreateAccount(randomUUID());

    const portfolio = await getPortfolio(account.id);

    expect(portfolio.cashCents).toBe(account.cashCents);
    expect(portfolio.positions).toEqual([]);
    expect(portfolio.recentOrders).toEqual([]);
  });

  it("returns every held position exactly once alongside recent orders", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    mockQuote({ symbol: "AAPL", askCents: toCents("100.00"), bidCents: toCents("99.00") });
    await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 10 });

    mockQuote({ symbol: "TSLA", askCents: toCents("200.00"), bidCents: toCents("199.00") });
    await placeMarketOrder({ userId, symbol: "TSLA", side: "buy", quantity: 5 });

    const portfolio = await getPortfolio(account.id);

    expect(portfolio.positions).toHaveLength(2);
    expect(portfolio.positions).toEqual(
      expect.arrayContaining([
        { symbol: "AAPL", quantity: 10, avgCostCents: toCents("100.00") },
        { symbol: "TSLA", quantity: 5, avgCostCents: toCents("200.00") },
      ]),
    );

    expect(portfolio.recentOrders).toHaveLength(2);
    expect(portfolio.recentOrders.every((order) => order.status === "filled")).toBe(true);
    // Most recent first.
    expect(portfolio.recentOrders[0]?.symbol).toBe("TSLA");
    expect(portfolio.recentOrders[1]?.symbol).toBe("AAPL");
  });

  it("caps recent orders at 20 and still returns every position", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    mockQuote({ symbol: "AAPL", askCents: toCents("100.00"), bidCents: toCents("99.00") });

    for (let i = 0; i < 25; i++) {
      await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 1 });
    }

    const portfolio = await getPortfolio(account.id);

    expect(portfolio.positions).toEqual([
      { symbol: "AAPL", quantity: 25, avgCostCents: toCents("100.00") },
    ]);
    expect(portfolio.recentOrders).toHaveLength(20);
  });

  it("includes rejected orders with no fill price alongside filled ones", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    mockQuote({ askCents: toCents("1000000.00") });

    await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 1 });

    const portfolio = await getPortfolio(account.id);

    expect(portfolio.positions).toEqual([]);
    expect(portfolio.recentOrders).toHaveLength(1);
    expect(portfolio.recentOrders[0]).toMatchObject({
      status: "rejected",
      filledPriceCents: null,
    });
  });
});
