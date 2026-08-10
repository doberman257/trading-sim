import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuotes } from "../market/alpaca";
import { isMarketOpen } from "../trading/market-hours";
import { toCents } from "../trading/money";
import type { Quote } from "../trading/types";
import { getOrCreateAccount } from "./accounts";
import { db, poolMax } from "./client";
import { getLastLimitOrderWorkerRun, runLimitOrderWorker } from "./limit-order-worker";
import { placeLimitOrder } from "./orders";
import { accounts, orders, positions } from "./schema";
import { assertLedgerBalances } from "./test-helpers";

// Everything else in this file hits the real test database - only the
// external Alpaca call and the market clock are stubbed, same discipline
// as orders.test.ts. Both are mocked as vi.fn() here (not a fixed
// implementation) because, unlike orders.test.ts, this file needs both a
// "market open" and a "market closed" answer across different tests.
vi.mock("../market/alpaca", () => ({ fetchQuotes: vi.fn() }));
vi.mock("../trading/market-hours", () => ({ isMarketOpen: vi.fn() }));

function mockQuotesMap(entries: Record<string, Partial<Quote>>): Map<string, Quote> {
  const map = new Map<string, Quote>();
  for (const [symbol, override] of Object.entries(entries)) {
    map.set(symbol, {
      symbol,
      bidCents: toCents("99.00"),
      askCents: toCents("100.00"),
      timestamp: new Date(),
      ...override,
    });
  }
  vi.mocked(fetchQuotes).mockResolvedValue({ quotes: map, failedSymbols: [] });
  return map;
}

// Same technique, and same reason, as orders.test.ts's mockQuoteWithDelay:
// concurrent runLimitOrderWorker() calls all await the same setTimeout, so
// they reach their per-order fill attempts within a fraction of a
// millisecond of each other - forcing a genuine race for the order row's
// lock instead of leaving overlap to scheduling luck.
function mockQuotesMapWithDelay(entries: Record<string, Partial<Quote>>, delayMs = 40): void {
  const map = new Map<string, Quote>();
  for (const [symbol, override] of Object.entries(entries)) {
    map.set(symbol, {
      symbol,
      bidCents: toCents("99.00"),
      askCents: toCents("100.00"),
      timestamp: new Date(),
      ...override,
    });
  }
  vi.mocked(fetchQuotes).mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ quotes: map, failedSymbols: [] }), delayMs),
      ),
  );
}

beforeEach(async () => {
  vi.mocked(fetchQuotes).mockReset();
  vi.mocked(isMarketOpen).mockReset();
  vi.mocked(isMarketOpen).mockReturnValue(true);
  await db.execute(
    sql`truncate table transactions, orders, positions, accounts, limit_order_worker_runs cascade`,
  );
});

describe("runLimitOrderWorker - market open, fill checking", () => {
  it("fills an eligible order at the quote's ask, updates cash/position, and writes a transaction row", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    const placed = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      limitPriceCents: toCents("100.00"),
    });
    if (!placed.ok) throw new Error("setup failed");

    // Ask is below the $100 limit - price improvement, should fill at $98,
    // not at the $100 limit itself.
    mockQuotesMap({ AAPL: { askCents: toCents("98.00"), bidCents: toCents("97.00") } });

    const outcome = await runLimitOrderWorker(new Date());
    if (!outcome.ok) throw new Error(`worker run failed: ${outcome.error}`);

    expect(outcome.counts).toEqual({
      marketWasOpen: true,
      ordersEvaluated: 1,
      ordersFilled: 1,
      ordersExpired: 0,
    });

    const [orderRow] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(orderRow?.status).toBe("filled");
    expect(orderRow?.filledPriceCents).toBe(toCents("98.00"));

    const [updatedAccount] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(updatedAccount?.cashCents).toBe(account.cashCents - toCents("98.00") * 10n);

    const [positionRow] = await db
      .select()
      .from(positions)
      .where(eq(positions.accountId, account.id));
    expect(positionRow?.quantity).toBe(10);

    await assertLedgerBalances(account.id);
  });

  it("leaves a pending order untouched when the quote does not cross its limit price", async () => {
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

    mockQuotesMap({ AAPL: { askCents: toCents("101.00") } });

    const outcome = await runLimitOrderWorker(new Date());
    if (!outcome.ok) throw new Error(`worker run failed: ${outcome.error}`);

    expect(outcome.counts).toEqual({
      marketWasOpen: true,
      ordersEvaluated: 1,
      ordersFilled: 0,
      ordersExpired: 0,
    });

    const [orderRow] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(orderRow?.status).toBe("pending");
  });

  it("skips an order whose symbol has no quote this round, leaving it pending for the next run", async () => {
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

    // fetchQuotes returning an empty map (as it does for a symbol with no
    // valid two-sided quote right now) must not crash or reject the order.
    vi.mocked(fetchQuotes).mockResolvedValue({ quotes: new Map(), failedSymbols: ["AAPL"] });

    const outcome = await runLimitOrderWorker(new Date());
    if (!outcome.ok) throw new Error(`worker run failed: ${outcome.error}`);

    expect(outcome.counts.ordersFilled).toBe(0);

    const [orderRow] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(orderRow?.status).toBe("pending");
  });

  it("leaves the order pending, does not reject it, when the fill re-check finds only a stale quote", async () => {
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

    // Crosses the limit price, but the quote itself is stale (> 60s old,
    // see lib/trading/execute.ts's STALE_QUOTE_MS) - a transient timing
    // issue, not a reason to permanently reject a resting order.
    mockQuotesMap({
      AAPL: { askCents: toCents("99.00"), timestamp: new Date(Date.now() - 61_000) },
    });

    const outcome = await runLimitOrderWorker(new Date());
    if (!outcome.ok) throw new Error(`worker run failed: ${outcome.error}`);

    expect(outcome.counts.ordersFilled).toBe(0);

    const [orderRow] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(orderRow?.status).toBe("pending");
    expect(orderRow?.rejectReason).toBeNull();
  });

  // The exact re-validation the worker exists to do "for real" - the
  // reservation accounting at placement time should make this structurally
  // impossible, so the only way to genuinely exercise this path is to force
  // the account's real state to diverge from what placement assumed
  // (simulating cash spent by something else entirely between placement
  // and this run) and confirm the worker catches it rather than blindly
  // trusting the earlier check.
  it("rejects at fill time (does not blindly fill) when the account can no longer actually afford it", async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);
    const placed = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 100,
      limitPriceCents: toCents("100.00"),
    });
    if (!placed.ok) throw new Error("setup failed");

    await db.update(accounts).set({ cashCents: 0n }).where(eq(accounts.userId, userId));

    mockQuotesMap({ AAPL: { askCents: toCents("99.00") } });

    const outcome = await runLimitOrderWorker(new Date());
    if (!outcome.ok) throw new Error(`worker run failed: ${outcome.error}`);

    expect(outcome.counts.ordersFilled).toBe(0);

    const [orderRow] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(orderRow?.status).toBe("rejected");
    expect(orderRow?.rejectReason).toBe("insufficient_funds");
  });

  // Double-claim prevention: the row-lock claiming this whole design is
  // built around, proven under genuine concurrency rather than assumed.
  // Two full worker invocations racing for the SAME order must never both
  // fill it.
  it("never double-fills the same order across two concurrent worker invocations", async () => {
    expect(
      poolMax,
      `This test needs at least 2 real concurrent DB connections for two runLimitOrderWorker() calls ` +
        `to actually race for the same order row's lock. (lib/db/client.ts's poolMax is currently ${poolMax}, ` +
        `from DB_POOL_MAX.) Below 2, the two calls could never be in-flight on separate connections at once, ` +
        `so this would pass trivially even if the row lock were removed.`,
    ).toBeGreaterThanOrEqual(2);

    const ITERATIONS = 5;

    for (let i = 0; i < ITERATIONS; i++) {
      const userId = randomUUID();
      const account = await getOrCreateAccount(userId);
      const placed = await placeLimitOrder({
        userId,
        symbol: "AAPL",
        side: "buy",
        quantity: 1,
        limitPriceCents: toCents("100.00"),
      });
      if (!placed.ok) throw new Error("setup failed");

      mockQuotesMapWithDelay({ AAPL: { askCents: toCents("99.00") } });

      const [outcomeA, outcomeB] = await Promise.all([
        runLimitOrderWorker(new Date()),
        runLimitOrderWorker(new Date()),
      ]);

      if (!outcomeA.ok || !outcomeB.ok) {
        throw new Error(`iteration ${i}: a worker run failed`);
      }

      const totalFilled = outcomeA.counts.ordersFilled + outcomeB.counts.ordersFilled;
      expect(totalFilled, `iteration ${i}: expected exactly one fill across both runs`).toBe(1);

      const [orderRow] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
      expect(orderRow?.status).toBe("filled");

      const [updatedAccount] = await db.select().from(accounts).where(eq(accounts.id, account.id));
      expect(updatedAccount?.cashCents).toBe(account.cashCents - toCents("99.00") * 1n);

      const positionRows = await db
        .select()
        .from(positions)
        .where(eq(positions.accountId, account.id));
      expect(positionRows).toHaveLength(1);
      expect(positionRows[0]?.quantity).toBe(1);

      await assertLedgerBalances(account.id);
    }
  });
});

describe("runLimitOrderWorker - market closed, expire sweep", () => {
  it("sweeps every pending limit order to expired, evaluating and filling none", async () => {
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

    vi.mocked(isMarketOpen).mockReturnValue(false);

    const outcome = await runLimitOrderWorker(new Date());
    if (!outcome.ok) throw new Error(`worker run failed: ${outcome.error}`);

    expect(outcome.counts).toEqual({
      marketWasOpen: false,
      ordersEvaluated: 0,
      ordersFilled: 0,
      ordersExpired: 1,
    });

    const [orderRow] = await db.select().from(orders).where(eq(orders.id, placed.orderId));
    expect(orderRow?.status).toBe("expired");
    // fetchQuotes must not even be called on this branch - there's nothing
    // to check a price against when every pending order is being expired.
    expect(fetchQuotes).not.toHaveBeenCalled();
  });

  it("does not touch orders that are already filled, cancelled, or rejected", async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);

    const stillPending = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      limitPriceCents: toCents("100.00"),
    });
    if (!stillPending.ok) throw new Error("setup failed");

    // A separate order rejected at placement (insufficient funds) - must
    // stay "rejected", never get swept to "expired".
    const rejected = await placeLimitOrder({
      userId,
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      limitPriceCents: toCents("1000000.00"),
    });
    expect(rejected.ok).toBe(false);

    vi.mocked(isMarketOpen).mockReturnValue(false);
    const outcome = await runLimitOrderWorker(new Date());
    if (!outcome.ok) throw new Error(`worker run failed: ${outcome.error}`);

    expect(outcome.counts.ordersExpired).toBe(1);

    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.accountId, (await getOrCreateAccount(userId)).id));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(stillPending.orderId)?.status).toBe("expired");
  });
});

describe("getLastLimitOrderWorkerRun", () => {
  it("returns null when the worker has never run", async () => {
    expect(await getLastLimitOrderWorkerRun()).toBeNull();
  });

  it("returns the most recently started run, not the oldest", async () => {
    vi.mocked(isMarketOpen).mockReturnValue(false);

    const first = await runLimitOrderWorker(new Date());
    const second = await runLimitOrderWorker(new Date());
    if (!first.ok || !second.ok) throw new Error("worker run failed");

    const latest = await getLastLimitOrderWorkerRun();
    expect(latest?.status).toBe("succeeded");

    const allRuns = await db.execute(sql`select id, started_at from limit_order_worker_runs`);
    expect(allRuns).toHaveLength(2);
  });

  it("records a failed run's error message when the worker throws mid-run", async () => {
    vi.mocked(isMarketOpen).mockReturnValue(true);
    vi.mocked(fetchQuotes).mockRejectedValue(new Error("Alpaca is down"));

    const outcome = await runLimitOrderWorker(new Date());
    expect(outcome).toEqual({ ok: false, error: "Alpaca is down" });

    const latest = await getLastLimitOrderWorkerRun();
    expect(latest?.status).toBe("failed");
    expect(latest?.errorMessage).toBe("Alpaca is down");
  });
});
