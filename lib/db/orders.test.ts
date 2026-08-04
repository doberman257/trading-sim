import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuote } from "../market/alpaca";
import { toCents } from "../trading/money";
import type { Quote } from "../trading/types";
import { getOrCreateAccount } from "./accounts";
import { db } from "./client";
import { placeMarketOrder } from "./orders";
import { accounts, orders, positions, transactions } from "./schema";
import { assertLedgerBalances } from "./test-helpers";

// Vitest hoists vi.mock calls above imports, so this replaces the real
// fetchQuote before orders.ts (imported below) ever sees it. Everything
// else in this file - transactions, locking, the ledger - hits the real
// test database; only the external Alpaca call is stubbed.
vi.mock("../market/alpaca", () => ({
  fetchQuote: vi.fn(),
}));

// executeMarketOrder (called by placeMarketOrder) checks the real market
// clock by default. Without this, every test here would pass or fail
// depending on what time - and what day - it happens to run, since none of
// them pass an explicit `now`. Market hours have their own dedicated,
// deterministic coverage in lib/trading/market-hours.test.ts; here we just
// need it to always say "open" so these tests exercise the DB logic.
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

// Same as mockQuote, but the mock only resolves after delayMs. Concurrent
// callers all await the same setTimeout, so they clear fetchQuote and enter
// their transactions within a fraction of a millisecond of each other -
// forcing the two transactions to genuinely overlap instead of leaving
// overlap to scheduling luck. Without this, both calls settle on their own
// independent schedule and can end up several milliseconds apart, which
// is enough time for one transaction to fully commit before the other
// even starts - so the race never gets exercised, and a missing row lock
// would go undetected.
function mockQuoteWithDelay(overrides: Partial<Quote> = {}, delayMs = 40): Quote {
  const quote: Quote = {
    symbol: "AAPL",
    bidCents: toCents("99.00"),
    askCents: toCents("100.00"),
    timestamp: new Date(),
    ...overrides,
  };

  vi.mocked(fetchQuote).mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve(quote), delayMs)),
  );

  return quote;
}

beforeEach(async () => {
  vi.mocked(fetchQuote).mockReset();
  await db.execute(sql`truncate table transactions, orders, positions, accounts cascade`);
});

describe("placeMarketOrder", () => {
  it("a successful buy decrements cash, creates a position, and writes exactly one transaction row", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    mockQuote({ askCents: toCents("100.00"), bidCents: toCents("99.00") });

    const transactionsBefore = await db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, account.id));

    const result = await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 10 });

    expect(result.ok).toBe(true);

    const [updatedAccount] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(updatedAccount?.cashCents).toBe(account.cashCents - toCents("100.00") * 10n);

    const positionRows = await db
      .select()
      .from(positions)
      .where(eq(positions.accountId, account.id));
    expect(positionRows).toHaveLength(1);
    expect(positionRows[0]?.quantity).toBe(10);
    expect(positionRows[0]?.avgCostCents).toBe(toCents("100.00"));

    const transactionsAfter = await db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, account.id));

    // Only the buy itself should add a row - the account's opening deposit
    // (written by getOrCreateAccount) is already counted in transactionsBefore.
    expect(transactionsAfter).toHaveLength(transactionsBefore.length + 1);
    const [newRow] = transactionsAfter.filter(
      (row) => !transactionsBefore.some((before) => before.id === row.id),
    );
    expect(newRow?.kind).toBe("buy");
    expect(newRow?.amountCents).toBe(-(toCents("100.00") * 10n));

    await assertLedgerBalances(account.id);
  });

  it('a rejected order writes an order row with status "rejected" and does not change cash', async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    // More than the $100,000 starting balance can cover.
    mockQuote({ askCents: toCents("1000000.00") });

    const result = await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 1 });

    expect(result).toEqual({ ok: false, reason: "insufficient_funds" });

    const [updatedAccount] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(updatedAccount?.cashCents).toBe(account.cashCents);

    const orderRows = await db.select().from(orders).where(eq(orders.accountId, account.id));
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.status).toBe("rejected");
    expect(orderRows[0]?.rejectReason).toBe("insufficient_funds");

    await assertLedgerBalances(account.id);
  });

  it("buying then selling the full position deletes the position row", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    mockQuote({ askCents: toCents("100.00"), bidCents: toCents("99.00") });

    const buyResult = await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 5 });
    expect(buyResult.ok).toBe(true);

    const sellResult = await placeMarketOrder({
      userId,
      symbol: "AAPL",
      side: "sell",
      quantity: 5,
    });
    expect(sellResult.ok).toBe(true);

    const positionRows = await db
      .select()
      .from(positions)
      .where(eq(positions.accountId, account.id));
    expect(positionRows).toHaveLength(0);

    await assertLedgerBalances(account.id);
  });

  it("after a sequence of orders, the sum of transaction amounts equals the account's cash balance", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    mockQuote({ askCents: toCents("100.00"), bidCents: toCents("95.00") });
    await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 10 });

    mockQuote({ askCents: toCents("110.00"), bidCents: toCents("105.00") });
    await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 5 });

    mockQuote({ askCents: toCents("120.00"), bidCents: toCents("115.00") });
    await placeMarketOrder({ userId, symbol: "AAPL", side: "sell", quantity: 8 });

    // Not enough shares left - should be rejected and must not disturb the ledger.
    const overSell = await placeMarketOrder({
      userId,
      symbol: "AAPL",
      side: "sell",
      quantity: 100,
    });
    expect(overSell.ok).toBe(false);

    await assertLedgerBalances(account.id);
  });

  it("two concurrent buy orders that together exceed the balance: exactly one succeeds, balance never goes negative", async () => {
    // Repeated across several fresh accounts in one test: a single pass
    // passing proves nothing about reliability, since the race this test
    // exercises is timing-dependent. Every iteration must independently
    // hold the invariant.
    const ITERATIONS = 8;

    for (let i = 0; i < ITERATIONS; i++) {
      const userId = randomUUID();
      const account = await getOrCreateAccount(userId); // $100,000 starting balance
      // $100.00/share * 600 = $60,000 per order - either alone fits in
      // $100,000, both together do not.
      mockQuoteWithDelay({ askCents: toCents("100.00"), bidCents: toCents("99.00") });

      const results = await Promise.all([
        placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 600 }),
        placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 600 }),
      ]);

      const succeeded = results.filter((result) => result.ok);
      expect(succeeded, `iteration ${i}: expected exactly one order to succeed`).toHaveLength(1);

      for (const result of results) {
        if (!result.ok) {
          expect(result.reason).toBe("insufficient_funds");
        }
      }

      const [updatedAccount] = await db.select().from(accounts).where(eq(accounts.id, account.id));
      expect(updatedAccount?.cashCents).toBe(account.cashCents - toCents("100.00") * 600n);
      expect(updatedAccount && updatedAccount.cashCents >= 0n).toBe(true);

      const positionRows = await db
        .select()
        .from(positions)
        .where(eq(positions.accountId, account.id));
      expect(positionRows).toHaveLength(1);
      expect(positionRows[0]?.quantity).toBe(600);

      await assertLedgerBalances(account.id);
    }
  });

  // This does not go through placeMarketOrder at all. It opens two raw
  // transactions directly and proves that `SELECT ... FOR UPDATE` on the
  // same account row genuinely blocks the second transaction until the
  // first commits. The test above (concurrent orders) only proves the
  // *outcome* is correct; it can't rule out that outcome being a scheduling
  // accident. This test proves the *mechanism* deterministically: the
  // second transaction is timed, and must take at least as long as the
  // first transaction's artificial hold time to complete its SELECT.
  it("a second SELECT ... FOR UPDATE on the same row blocks until the first transaction ends", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;

    if (!testDatabaseUrl) {
      throw new Error("Missing TEST_DATABASE_URL");
    }

    const rawSql = postgres(testDatabaseUrl, { prepare: false });

    try {
      const start = Date.now();
      let secondAcquiredAfterMs: number | null = null;

      const firstTransaction = rawSql.begin(async (tx) => {
        await tx`select * from accounts where id = ${account.id} for update`;
        await new Promise((resolve) => setTimeout(resolve, 300));
      });

      // Give the first transaction a head start so it acquires the lock first.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const secondTransaction = rawSql.begin(async (tx) => {
        await tx`select * from accounts where id = ${account.id} for update`;
        secondAcquiredAfterMs = Date.now() - start;
      });

      await Promise.all([firstTransaction, secondTransaction]);

      if (secondAcquiredAfterMs === null) {
        throw new Error("second transaction never acquired the lock");
      }

      expect(secondAcquiredAfterMs).toBeGreaterThanOrEqual(300);
    } finally {
      await rawSql.end();
    }
  });
});
