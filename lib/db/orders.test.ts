import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuote, NoTwoSidedQuoteError } from "../market/alpaca";
import { toCents } from "../trading/money";
import type { Quote } from "../trading/types";
import { getOrCreateAccount } from "./accounts";
import { db, poolMax } from "./client";
import {
  cancelOrder,
  getFilledOrdersForSymbol,
  getOrdersForAccount,
  placeLimitOrder,
  placeMarketOrder,
} from "./orders";
import { accounts, orders, positions, transactions } from "./schema";
import { assertLedgerBalances } from "./test-helpers";

// Vitest hoists vi.mock calls above imports, so this replaces the real
// fetchQuote before orders.ts (imported below) ever sees it. Everything
// else in this file - transactions, locking, the ledger - hits the real
// test database; only the external Alpaca call is stubbed. The real
// NoTwoSidedQuoteError class is kept (not mocked away) so tests below can
// mock fetchQuote to reject with a real `instanceof` match, exactly as
// placeMarketOrder's own catch block checks for it.
vi.mock("../market/alpaca", async () => {
  const actual = await vi.importActual<typeof import("../market/alpaca")>("../market/alpaca");
  return {
    fetchQuote: vi.fn(),
    NoTwoSidedQuoteError: actual.NoTwoSidedQuoteError,
  };
});

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

  // Real market condition, not a hypothetical: Alpaca reports a zero-priced
  // bid or ask when there's no active two-sided quote (most often while
  // the market is closed) - fetchQuote turns that into a NoTwoSidedQuoteError
  // rather than a Quote with a $0.00 side. placeMarketOrder must turn that
  // into an ordinary rejection, not let it propagate as an unhandled
  // throw - CLAUDE.md's "order rejection is a normal outcome" rule applies
  // here just as much as to insufficient_funds/insufficient_shares.
  it('rejects with "no_quote" and still logs the order when Alpaca has no two-sided quote, without touching cash', async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    vi.mocked(fetchQuote).mockRejectedValue(new NoTwoSidedQuoteError("AAPL"));

    const result = await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 1 });

    expect(result).toEqual({ ok: false, reason: "no_quote" });

    const [updatedAccount] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(updatedAccount?.cashCents).toBe(account.cashCents);

    const orderRows = await db.select().from(orders).where(eq(orders.accountId, account.id));
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.status).toBe("rejected");
    expect(orderRows[0]?.rejectReason).toBe("no_quote");

    await assertLedgerBalances(account.id);
  });

  it("still throws for a genuine fetchQuote failure unrelated to a missing quote (e.g. a config error)", async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);
    vi.mocked(fetchQuote).mockRejectedValue(new Error("Missing ALPACA_KEY_ID"));

    await expect(
      placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 1 }),
    ).rejects.toThrow(/Missing ALPACA_KEY_ID/);
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
    // This test is worthless below 2: with only one connection available,
    // postgres.js queues the second placeMarketOrder's transaction
    // client-side until the first releases its connection, so the two
    // transactions can never actually be in-flight on separate connections
    // at once - the exact scenario SELECT ... FOR UPDATE exists to guard
    // against never gets created, and this test would pass even with that
    // lock deleted (this happened for real - see STATE.md's gotcha on it).
    // Failing loudly here beats a green test that silently stopped proving
    // anything the moment lib/db/client.ts's pool size changed.
    expect(
      poolMax,
      `This test needs at least 2 real concurrent DB connections to exercise the SELECT ... FOR UPDATE lock ` +
        `(lib/db/client.ts's poolMax is currently ${poolMax}, from DB_POOL_MAX). With only one connection, the ` +
        `two placeMarketOrder calls below can never run concurrently - postgres.js serializes them client-side ` +
        `before either reaches Postgres - so this test would pass trivially even if the row lock were removed. ` +
        `Set DB_POOL_MAX >= 2 in vitest.integration.setup.ts.`,
    ).toBeGreaterThanOrEqual(2);

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

describe("placeLimitOrder", () => {
  it("accepts a valid buy and inserts it as pending, without touching cash", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    const result = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      limitPriceCents: toCents("100.00"),
    });

    expect(result.ok).toBe(true);

    const [updatedAccount] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(updatedAccount?.cashCents).toBe(account.cashCents);

    const orderRows = await db.select().from(orders).where(eq(orders.accountId, account.id));
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.status).toBe("pending");
    expect(orderRows[0]?.type).toBe("limit");
    expect(orderRows[0]?.limitPriceCents).toBe(toCents("100.00"));

    await assertLedgerBalances(account.id);
  });

  it('rejects with "insufficient_funds" and still logs the order when the order alone exceeds cash', async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    const result = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      limitPriceCents: toCents("1000000.00"),
    });

    expect(result).toEqual({ ok: false, reason: "insufficient_funds" });

    const orderRows = await db.select().from(orders).where(eq(orders.accountId, account.id));
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.status).toBe("rejected");
    expect(orderRows[0]?.rejectReason).toBe("insufficient_funds");
  });

  it('rejects with "insufficient_shares" for a sell of a symbol not held', async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);

    const result = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "sell",
      quantity: 1,
      limitPriceCents: toCents("100.00"),
    });

    expect(result).toEqual({ ok: false, reason: "insufficient_shares" });
  });

  it('rejects with "invalid_limit_price" for a zero limit price', async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);

    const result = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      limitPriceCents: 0n,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_limit_price" });
  });

  // The reservation math itself is unit-tested in isolation
  // (lib/trading/limit-reservation.test.ts) - this proves placeLimitOrder
  // actually wires that logic up against real, persisted pending orders,
  // not just that the pure function is correct on its own.
  it("rejects a second buy once the first's reservation exhausts available cash", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    // $100,000 cash. First order reserves $90,000 (900 * $100).
    const first = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 900,
      limitPriceCents: toCents("100.00"),
    });
    expect(first.ok).toBe(true);

    // A second order for $20,000 (200 * $100) - only $10,000 remains.
    const second = await placeLimitOrder({
      userId,
      symbol: "TSLA",
      side: "buy",
      quantity: 200,
      limitPriceCents: toCents("100.00"),
    });
    expect(second).toEqual({ ok: false, reason: "insufficient_funds" });

    // Cash itself is untouched either way - nothing fills at placement time.
    const [updatedAccount] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(updatedAccount?.cashCents).toBe(account.cashCents);
  });
});

describe("cancelOrder", () => {
  it("cancels a real pending order", async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);
    const placed = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      limitPriceCents: toCents("100.00"),
    });
    if (!placed.ok) throw new Error("setup failed");

    const result = await cancelOrder(userId, placed.orderId);
    expect(result).toEqual({ ok: true });

    const [orderRow] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(orderRow?.status).toBe("cancelled");
  });

  it('reports "not_found" for an unknown order id', async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);

    const result = await cancelOrder(userId, randomUUID());
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  // Also covers the cross-account case: an order id that's real but
  // belongs to a different account must look identical to an id that
  // doesn't exist at all - see cancelOrder's own comment on why.
  it('reports "not_found" for another account\'s order, not a permission error that would confirm it exists', async () => {
    const ownerUserId = randomUUID();
    await getOrCreateAccount(ownerUserId);
    const placed = await placeLimitOrder({
      userId: ownerUserId,
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      limitPriceCents: toCents("100.00"),
    });
    if (!placed.ok) throw new Error("setup failed");

    const attackerUserId = randomUUID();
    await getOrCreateAccount(attackerUserId);

    const result = await cancelOrder(attackerUserId, placed.orderId);
    expect(result).toEqual({ ok: false, reason: "not_found" });

    // The real owner's order must be untouched.
    const [orderRow] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(orderRow?.status).toBe("pending");
  });

  it('reports "not_cancellable" for an order that is already cancelled', async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);
    const placed = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      limitPriceCents: toCents("100.00"),
    });
    if (!placed.ok) throw new Error("setup failed");

    await cancelOrder(userId, placed.orderId);
    const secondAttempt = await cancelOrder(userId, placed.orderId);

    expect(secondAttempt).toEqual({ ok: false, reason: "not_cancellable" });
  });

  // The exact race this app's design is built to handle correctly: a
  // cancellation and an in-progress fill both want the same order row's
  // lock. This holds a real lock on the order (via a second raw
  // connection, not cancelOrder itself) for a fixed, known duration, then
  // marks it filled - proving cancelOrder's own SELECT ... FOR UPDATE
  // genuinely blocks on that lock (timed, not assumed) and, once
  // unblocked, correctly reports "already_filled" rather than a silent
  // success or a generic error. Same technique as the deterministic
  // account-lock test above, applied to the order-row lock instead.
  it('returns "already_filled", not ok:true or an error, when it loses the row lock to an in-progress fill', async () => {
    expect(
      poolMax,
      `This test needs at least 2 real concurrent DB connections: one to hold the order row's lock ` +
        `while simulating an in-progress fill, one for cancelOrder's own SELECT ... FOR UPDATE to genuinely ` +
        `block on. (lib/db/client.ts's poolMax is currently ${poolMax}, from DB_POOL_MAX.) Below 2, ` +
        `cancelOrder could never actually contend for the lock this test holds, and would trivially "win" ` +
        `every time regardless of whether the lock is real.`,
    ).toBeGreaterThanOrEqual(2);

    const userId = randomUUID();
    await getOrCreateAccount(userId);
    const placed = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      limitPriceCents: toCents("100.00"),
    });
    if (!placed.ok) throw new Error("setup failed");

    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (!testDatabaseUrl) {
      throw new Error("Missing TEST_DATABASE_URL");
    }

    const rawSql = postgres(testDatabaseUrl, { prepare: false });

    try {
      const start = Date.now();
      let cancelResolvedAfterMs: number | null = null;

      const simulatedFill = rawSql.begin(async (tx) => {
        await tx`select * from orders where id = ${placed.orderId} for update`;
        await new Promise((resolve) => setTimeout(resolve, 300));
        await tx`update orders set status = 'filled', filled_price_cents = 10000, filled_at = now() where id = ${placed.orderId}`;
      });

      // Give the simulated fill a head start so it acquires the lock first.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const cancelPromise = cancelOrder(userId, placed.orderId).then((result) => {
        cancelResolvedAfterMs = Date.now() - start;
        return result;
      });

      const [, cancelResult] = await Promise.all([simulatedFill, cancelPromise]);

      if (cancelResolvedAfterMs === null) {
        throw new Error("cancelOrder never returned");
      }

      // Proves cancelOrder genuinely blocked on the held lock rather than
      // reading a stale/unlocked status - it can't have resolved before
      // the simulated fill's own 300ms hold released it.
      expect(cancelResolvedAfterMs).toBeGreaterThanOrEqual(300);
      expect(cancelResult).toEqual({ ok: false, reason: "already_filled" });
    } finally {
      await rawSql.end();
    }
  });
});

describe("getFilledOrdersForSymbol", () => {
  it("returns only filled orders for that symbol, oldest first", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    mockQuote({ symbol: "AAPL", askCents: toCents("100.00"), bidCents: toCents("99.00") });
    await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 10 });

    mockQuote({ symbol: "AAPL", askCents: toCents("110.00"), bidCents: toCents("108.00") });
    await placeMarketOrder({ userId, symbol: "AAPL", side: "sell", quantity: 4 });

    // A different symbol and a rejected order - neither should come back.
    mockQuote({ symbol: "TSLA", askCents: toCents("200.00"), bidCents: toCents("199.00") });
    await placeMarketOrder({ userId, symbol: "TSLA", side: "buy", quantity: 1 });
    mockQuote({ symbol: "AAPL", askCents: toCents("1000000.00") });
    await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 1 });

    const fills = await getFilledOrdersForSymbol(account.id, "AAPL");

    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({
      side: "buy",
      quantity: 10,
      filledPriceCents: toCents("100.00"),
    });
    expect(fills[1]).toMatchObject({
      side: "sell",
      quantity: 4,
      filledPriceCents: toCents("108.00"),
    });
    expect(fills[0]?.filledAt.getTime()).toBeLessThanOrEqual(fills[1]?.filledAt.getTime() ?? 0);
  });

  it("returns an empty list for a symbol with no fills", async () => {
    const account = await getOrCreateAccount(randomUUID());

    expect(await getFilledOrdersForSymbol(account.id, "AAPL")).toEqual([]);
  });
});

describe("getOrdersForAccount", () => {
  it("returns every order type and status, newest first, with the full shape a read API needs", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    mockQuote({ symbol: "AAPL", askCents: toCents("100.00"), bidCents: toCents("99.00") });
    await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 5 });

    const placedLimit = await placeLimitOrder({
      userId,
      symbol: "TSLA",
      side: "buy",
      quantity: 2,
      limitPriceCents: toCents("200.00"),
    });
    if (!placedLimit.ok) throw new Error("setup failed");

    const rows = await getOrdersForAccount(account.id);

    expect(rows).toHaveLength(2);
    // Newest first - the limit order was placed after the market order.
    expect(rows[0]).toMatchObject({
      symbol: "TSLA",
      side: "buy",
      type: "limit",
      quantity: 2,
      status: "pending",
      limitPriceCents: toCents("200.00"),
      filledPriceCents: null,
    });
    expect(rows[1]).toMatchObject({
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 5,
      status: "filled",
      limitPriceCents: null,
      filledPriceCents: toCents("100.00"),
    });
  });

  it("filters to a single status when asked", async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);

    mockQuote({ symbol: "AAPL", askCents: toCents("100.00"), bidCents: toCents("99.00") });
    await placeMarketOrder({ userId, symbol: "AAPL", side: "buy", quantity: 5 });

    const placedLimit = await placeLimitOrder({
      userId,
      symbol: "TSLA",
      side: "buy",
      quantity: 2,
      limitPriceCents: toCents("200.00"),
    });
    if (!placedLimit.ok) throw new Error("setup failed");

    const account = await getOrCreateAccount(userId);
    const pendingOnly = await getOrdersForAccount(account.id, { status: "pending" });

    expect(pendingOnly).toHaveLength(1);
    expect(pendingOnly[0]?.symbol).toBe("TSLA");
  });

  it("returns an empty list for an account with no orders", async () => {
    const account = await getOrCreateAccount(randomUUID());

    expect(await getOrdersForAccount(account.id)).toEqual([]);
  });
});
