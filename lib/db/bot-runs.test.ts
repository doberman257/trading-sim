import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar } from "../market/alpaca";
import { fetchDailyBarsForSymbols, fetchQuotes } from "../market/alpaca";
import { isApproachingMarketClose } from "../trading/bot-day-expiry";
import { rsi, sma } from "../trading/indicators";
import { isMarketOpen } from "../trading/market-hours";
import { toCents } from "../trading/money";
import type { Quote } from "../trading/types";
import { getOrCreateAccount } from "./accounts";
import { createBotRun, getBotRunsForAccount, runBotWorker } from "./bot-runs";
import { db, poolMax } from "./client";
import { runLimitOrderWorker } from "./limit-order-worker";
import { cancelOrderByAccountId } from "./orders";
import { accounts, botRuns, orders } from "./schema";
import { assertLedgerBalances } from "./test-helpers";

// Same discipline as limit-order-worker.test.ts: everything else hits the
// real test database, only the external Alpaca calls, the market clock,
// and the indicator math are stubbed. Indicators are mocked wholesale
// (not fed a real price series) because this file's job is proving the
// bot's ORCHESTRATION - order tagging, lock-based claiming, the
// cancel-vs-fill race - not re-proving RSI/SMA's own math, which already
// has its own dedicated, published-example-cross-checked test suite.
vi.mock("../market/alpaca", () => ({ fetchQuotes: vi.fn(), fetchDailyBarsForSymbols: vi.fn() }));
vi.mock("../trading/market-hours", () => ({ isMarketOpen: vi.fn() }));
vi.mock("../trading/bot-day-expiry", () => ({ isApproachingMarketClose: vi.fn() }));
vi.mock("../trading/indicators", () => ({ rsi: vi.fn(), sma: vi.fn(), DEFAULT_RSI_PERIOD: 14 }));

function bar(closeCents: bigint, volume: number): Bar {
  return {
    timestamp: new Date().toISOString(),
    openCents: closeCents,
    highCents: closeCents,
    lowCents: closeCents,
    closeCents,
    volume,
  };
}

// Configures the mocks so exactly one watchlist symbol ("AAPL", already in
// BOT_WATCHLIST_SYMBOLS) reads as an eligible entry candidate: RSI 25 (below
// the 30 threshold), latest close $105 above a mocked SMA of $100 (10000
// fractional cents, matching indicators.ts's own output convention).
function mockEligibleCandidate(quote: Partial<Quote> = {}): void {
  vi.mocked(fetchDailyBarsForSymbols).mockResolvedValue(
    new Map([["AAPL", [bar(toCents("105.00"), 1_000_000)]]]),
  );
  vi.mocked(fetchQuotes).mockResolvedValue({
    quotes: new Map([
      [
        "AAPL",
        {
          symbol: "AAPL",
          bidCents: toCents("99.50"),
          askCents: toCents("100.00"),
          timestamp: new Date(),
          ...quote,
        },
      ],
    ]),
    failedSymbols: [],
  });
  vi.mocked(rsi).mockReturnValue([25]);
  vi.mocked(sma).mockReturnValue([10000]);
}

function mockNoEligibleCandidates(): void {
  vi.mocked(fetchDailyBarsForSymbols).mockResolvedValue(
    new Map([["AAPL", [bar(toCents("105.00"), 1_000_000)]]]),
  );
  vi.mocked(fetchQuotes).mockResolvedValue({
    quotes: new Map([
      [
        "AAPL",
        {
          symbol: "AAPL",
          bidCents: toCents("99.50"),
          askCents: toCents("100.00"),
          timestamp: new Date(),
        },
      ],
    ]),
    failedSymbols: [],
  });
  vi.mocked(rsi).mockReturnValue([45]); // not oversold
  vi.mocked(sma).mockReturnValue([10000]);
}

beforeEach(async () => {
  vi.mocked(fetchQuotes).mockReset();
  vi.mocked(fetchDailyBarsForSymbols).mockReset();
  vi.mocked(isMarketOpen).mockReset();
  vi.mocked(isMarketOpen).mockReturnValue(true);
  vi.mocked(isApproachingMarketClose).mockReset();
  vi.mocked(isApproachingMarketClose).mockReturnValue(false);
  vi.mocked(rsi).mockReset();
  vi.mocked(sma).mockReset();
  await db.execute(
    sql`truncate table transactions, orders, positions, bot_runs, accounts, limit_order_worker_runs cascade`,
  );
});

describe("createBotRun", () => {
  it("rejects zero or negative capital", async () => {
    const userId = randomUUID();
    const result = await createBotRun({
      userId,
      capitalCents: 0n,
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    expect(result).toEqual({ ok: false, reason: "invalid_capital" });
  });

  it("rejects a profit target that exceeds the capital committed", async () => {
    const userId = randomUUID();
    const result = await createBotRun({
      userId,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("1000.01") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    expect(result).toEqual({ ok: false, reason: "invalid_profit_target" });
  });

  it("rejects an invalid stop-loss", async () => {
    const userId = randomUUID();
    const result = await createBotRun({
      userId,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "percent", basisPoints: 0 },
    });
    expect(result).toEqual({ ok: false, reason: "invalid_stop_loss" });
  });

  it("creates a run in 'selecting' status with the rule id/params attached", async () => {
    const userId = randomUUID();
    const result = await createBotRun({
      userId,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db.select().from(botRuns).where(eq(botRuns.id, result.runId));
    expect(row?.status).toBe("selecting");
    expect(row?.ruleId).toBe("rsi_pullback_uptrend_v1");
    expect(row?.ruleParams).toMatchObject({ rsiEntryThreshold: 30, rsiExitThreshold: 50 });
  });
});

describe("runBotWorker - selection cycle", () => {
  it("enters a run when a watchlist candidate qualifies, tagging the entry order and placing a resting profit-target sell", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    const created = await createBotRun({
      userId,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    if (!created.ok) throw new Error("setup failed");

    mockEligibleCandidate();

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsEntered).toBe(1);

    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, created.runId));
    expect(run?.status).toBe("holding");
    expect(run?.selectedSymbol).toBe("AAPL");
    expect(run?.entryQuantity).toBe(10); // $1000 / $100.00 ask
    expect(run?.entryTotalCents).toBe(toCents("1000.00"));

    const runOrders = await db.select().from(orders).where(eq(orders.botRunId, created.runId));
    const buyOrder = runOrders.find((order) => order.side === "buy");
    expect(buyOrder?.status).toBe("filled");
    expect(buyOrder?.type).toBe("market");
    expect(buyOrder?.filledPriceCents).toBe(toCents("100.00"));

    const sellOrder = runOrders.find((order) => order.side === "sell");
    expect(sellOrder?.status).toBe("pending");
    expect(sellOrder?.type).toBe("limit");
    expect(sellOrder?.quantity).toBe(10);
    // ($1000.00 entry + $50.00 target) / 10 shares = $105.00 exactly.
    expect(sellOrder?.limitPriceCents).toBe(toCents("105.00"));

    await assertLedgerBalances(account.id);
  });

  it("leaves a run in 'selecting' when nothing on the watchlist currently qualifies", async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);
    const created = await createBotRun({
      userId,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    if (!created.ok) throw new Error("setup failed");

    mockNoEligibleCandidates();

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsEntered).toBe(0);

    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, created.runId));
    expect(run?.status).toBe("selecting");

    const runOrders = await db.select().from(orders).where(eq(orders.botRunId, created.runId));
    expect(runOrders).toHaveLength(0);
  });

  it("fails a run with 'failed_no_affordable_candidate' when an eligible candidate exists but its price exceeds the run's capital", async () => {
    const userId = randomUUID();
    await getOrCreateAccount(userId);
    const created = await createBotRun({
      userId,
      capitalCents: toCents("10.00"), // far below AAPL's $100.00 ask
      profitTarget: { type: "dollar", valueCents: toCents("1.00") },
      stopLoss: { type: "dollar", valueCents: toCents("1.00") },
    });
    if (!created.ok) throw new Error("setup failed");

    mockEligibleCandidate();

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsFailedNoAffordableCandidate).toBe(1);

    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, created.runId));
    expect(run?.status).toBe("failed_no_affordable_candidate");
    expect(run?.closedAt).not.toBeNull();
  });
});

// Sets up a real "holding" run (via a real selection cycle, not hand-
// inserted rows) with a resting profit-target sell already placed, for the
// monitoring-cycle tests below.
async function createHoldingRun(
  userId: string,
  profitTargetValueCents: bigint,
  stopLossValueCents: bigint,
): Promise<{ runId: string; accountId: string; targetOrderId: string }> {
  const account = await getOrCreateAccount(userId);
  const created = await createBotRun({
    userId,
    capitalCents: toCents("1000.00"),
    profitTarget: { type: "dollar", valueCents: profitTargetValueCents },
    stopLoss: { type: "dollar", valueCents: stopLossValueCents },
  });
  if (!created.ok) throw new Error("setup failed");

  mockEligibleCandidate();
  const outcome = await runBotWorker(new Date());
  if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);

  const [targetOrder] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.botRunId, created.runId), eq(orders.side, "sell")));
  if (!targetOrder) throw new Error("setup did not produce a resting target order");

  return { runId: created.runId, accountId: account.id, targetOrderId: targetOrder.id };
}

describe("runBotWorker - monitoring cycle", () => {
  it("closes as closed_target (bookkeeping only) once the resting limit sell has already filled", async () => {
    const userId = randomUUID();
    const { runId, accountId, targetOrderId } = await createHoldingRun(
      userId,
      toCents("50.00"),
      toCents("30.00"),
    );

    // Simulate the limit-order worker having already filled this resting
    // order in an earlier or concurrent cycle.
    await db
      .update(orders)
      .set({ status: "filled", filledPriceCents: toCents("105.00"), filledAt: new Date() })
      .where(eq(orders.id, targetOrderId));

    mockEligibleCandidate(); // bars/quotes still need to resolve for the monitoring fetch

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsClosed).toBe(1);

    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, runId));
    expect(run?.status).toBe("closed_target");
    expect(run?.realizedPnlCents).toBe(toCents("50.00")); // $1050 exit - $1000 entry
    expect(run?.closedAt).not.toBeNull();

    await assertLedgerBalances(accountId);
  });

  it("cancels the resting target order and closes as closed_stop_loss when the loss threshold is hit", async () => {
    const userId = randomUUID();
    const { runId, accountId, targetOrderId } = await createHoldingRun(
      userId,
      toCents("50.00"),
      toCents("30.00"),
    );

    // Bid $96.00 on 10 shares -> unrealized P&L of -$40.00, past the $30
    // stop-loss.
    vi.mocked(fetchQuotes).mockResolvedValue({
      quotes: new Map([
        [
          "AAPL",
          {
            symbol: "AAPL",
            bidCents: toCents("96.00"),
            askCents: toCents("97.00"),
            timestamp: new Date(),
          },
        ],
      ]),
      failedSymbols: [],
    });

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsClosed).toBe(1);

    const [cancelledTarget] = await db.select().from(orders).where(eq(orders.id, targetOrderId));
    expect(cancelledTarget?.status).toBe("cancelled");

    const exitOrders = await db
      .select()
      .from(orders)
      .where(and(eq(orders.botRunId, runId), eq(orders.side, "sell"), eq(orders.type, "market")));
    expect(exitOrders).toHaveLength(1);
    expect(exitOrders[0]?.status).toBe("filled");
    expect(exitOrders[0]?.filledPriceCents).toBe(toCents("96.00"));

    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, runId));
    expect(run?.status).toBe("closed_stop_loss");
    expect(run?.realizedPnlCents).toBe(-toCents("40.00"));

    await assertLedgerBalances(accountId);
  });

  it("closes as closed_day_expiry when the market is approaching close, even with no P&L trigger", async () => {
    const userId = randomUUID();
    const { runId } = await createHoldingRun(userId, toCents("50.00"), toCents("30.00"));

    vi.mocked(fetchQuotes).mockResolvedValue({
      quotes: new Map([
        [
          "AAPL",
          {
            symbol: "AAPL",
            bidCents: toCents("100.00"),
            askCents: toCents("101.00"),
            timestamp: new Date(),
          },
        ],
      ]),
      failedSymbols: [],
    });
    vi.mocked(isApproachingMarketClose).mockReturnValue(true);

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsClosed).toBe(1);

    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, runId));
    expect(run?.status).toBe("closed_day_expiry");
  });

  it("closes as closed_rule_exit when RSI recovers above the exit threshold and nothing else has fired", async () => {
    const userId = randomUUID();
    const { runId } = await createHoldingRun(userId, toCents("50.00"), toCents("30.00"));

    vi.mocked(fetchQuotes).mockResolvedValue({
      quotes: new Map([
        [
          "AAPL",
          {
            symbol: "AAPL",
            bidCents: toCents("102.00"),
            askCents: toCents("103.00"),
            timestamp: new Date(),
          },
        ],
      ]),
      failedSymbols: [],
    });
    vi.mocked(fetchDailyBarsForSymbols).mockResolvedValue(
      new Map([["AAPL", [bar(toCents("103.00"), 1_000_000)]]]),
    );
    vi.mocked(rsi).mockReturnValue([55]); // recovered above the exit threshold (50)

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsClosed).toBe(1);

    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, runId));
    expect(run?.status).toBe("closed_rule_exit");
  });

  it("does not close when no exit condition has fired", async () => {
    const userId = randomUUID();
    const { runId } = await createHoldingRun(userId, toCents("50.00"), toCents("30.00"));

    vi.mocked(fetchQuotes).mockResolvedValue({
      quotes: new Map([
        [
          "AAPL",
          {
            symbol: "AAPL",
            bidCents: toCents("101.00"),
            askCents: toCents("102.00"),
            timestamp: new Date(),
          },
        ],
      ]),
      failedSymbols: [],
    });
    vi.mocked(fetchDailyBarsForSymbols).mockResolvedValue(
      new Map([["AAPL", [bar(toCents("101.00"), 1_000_000)]]]),
    );
    vi.mocked(rsi).mockReturnValue([35]); // still oversold-ish, not recovered

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsClosed).toBe(0);

    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, runId));
    expect(run?.status).toBe("holding");
  });
});

describe("getBotRunsForAccount", () => {
  it("returns an account's runs, newest first", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    mockNoEligibleCandidates();

    const first = await createBotRun({
      userId,
      capitalCents: toCents("500.00"),
      profitTarget: { type: "dollar", valueCents: toCents("20.00") },
      stopLoss: { type: "dollar", valueCents: toCents("20.00") },
    });
    const second = await createBotRun({
      userId,
      capitalCents: toCents("700.00"),
      profitTarget: { type: "dollar", valueCents: toCents("30.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    if (!first.ok || !second.ok) throw new Error("setup failed");

    const runs = await getBotRunsForAccount(account.id);
    expect(runs.map((run) => run.id)).toEqual([second.runId, first.runId]);
  });
});

// The exact race the design brief calls out explicitly: the resting
// profit-target limit sell and a monitoring cycle that wants to close the
// run for a DIFFERENT reason (stop-loss, here) both ultimately depend on
// the same order row's lock. Proven in both directions with real
// production code on both sides - runLimitOrderWorker (the real fill path)
// and cancelOrderByAccountId (the real cancellation path) - not a
// reimplemented stand-in for either.
describe("cancel-vs-fill race for the resting profit-target order", () => {
  it("fill wins: when the limit-order worker fills the resting order first, the bot's cancellation correctly reports already_filled", async () => {
    expect(
      poolMax,
      `This test needs at least 2 real concurrent DB connections to race cancelOrderByAccountId ` +
        `against runLimitOrderWorker for the same order row's lock. (lib/db/client.ts's poolMax is ` +
        `currently ${poolMax}, from DB_POOL_MAX.) Below 2, the two calls could never be in-flight on ` +
        `separate connections at once, so this would pass trivially even if the row lock were removed.`,
    ).toBeGreaterThanOrEqual(2);

    const userId = randomUUID();
    const { runId, targetOrderId } = await createHoldingRun(
      userId,
      toCents("50.00"),
      toCents("30.00"),
    );

    // A quote that crosses the resting $105.00 limit (bid >= limit) -
    // resolved immediately, no delay, so the fill's transaction reaches
    // the order row's lock first.
    vi.mocked(fetchQuotes).mockResolvedValue({
      quotes: new Map([
        [
          "AAPL",
          {
            symbol: "AAPL",
            bidCents: toCents("106.00"),
            askCents: toCents("107.00"),
            timestamp: new Date(),
          },
        ],
      ]),
      failedSymbols: [],
    });
    vi.mocked(isMarketOpen).mockReturnValue(true);

    // Delay the cancellation's own start slightly so the fill's
    // transaction has already acquired (and, most of the time, released)
    // the lock by the time this one attempts it - engineered so this
    // specific test reliably exercises the "fill won" branch, not left
    // to scheduling luck.
    const delayedCancel = new Promise<Awaited<ReturnType<typeof cancelOrderByAccountId>>>(
      (resolve) => {
        setTimeout(() => {
          resolve(cancelOrderByAccountIdForOrder(targetOrderId));
        }, 15);
      },
    );

    const [fillOutcome, cancelResult] = await Promise.all([
      runLimitOrderWorker(new Date()),
      delayedCancel,
    ]);

    if (!fillOutcome.ok) throw new Error(`limit-order worker failed: ${fillOutcome.error}`);

    const [finalOrder] = await db.select().from(orders).where(eq(orders.id, targetOrderId));
    expect(finalOrder?.status).toBe("filled");
    expect(cancelResult).toEqual({ ok: false, reason: "already_filled" });

    // The bot run itself is unaffected by the race's losing side - only
    // the monitoring cycle (which isn't invoked here) would act on this
    // already_filled outcome by closing it as closed_target. Confirms
    // the run is still exactly where it was, not corrupted by the race.
    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, runId));
    expect(run?.status).toBe("holding");
  });

  it("cancel wins: when the bot cancels the resting order before any quote crosses it, the limit-order worker correctly leaves it alone", async () => {
    expect(poolMax).toBeGreaterThanOrEqual(2);

    const userId = randomUUID();
    const { targetOrderId } = await createHoldingRun(userId, toCents("50.00"), toCents("30.00"));

    // Delay the limit-order worker's own quote fetch so its transaction
    // reaches the order row well after the cancellation (which has no
    // network call in its own path) has already committed.
    vi.mocked(fetchQuotes).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                quotes: new Map([
                  [
                    "AAPL",
                    {
                      symbol: "AAPL",
                      bidCents: toCents("106.00"),
                      askCents: toCents("107.00"),
                      timestamp: new Date(),
                    },
                  ],
                ]),
                failedSymbols: [],
              }),
            50,
          ),
        ),
    );
    vi.mocked(isMarketOpen).mockReturnValue(true);

    const [fillOutcome, cancelResult] = await Promise.all([
      runLimitOrderWorker(new Date()),
      cancelOrderByAccountIdForOrder(targetOrderId),
    ]);

    if (!fillOutcome.ok) throw new Error(`limit-order worker failed: ${fillOutcome.error}`);
    expect(fillOutcome.counts.ordersFilled).toBe(0);
    expect(cancelResult).toEqual({ ok: true });

    const [finalOrder] = await db.select().from(orders).where(eq(orders.id, targetOrderId));
    expect(finalOrder?.status).toBe("cancelled");
  });
});

// Small helper so both race tests can cancel by order id alone, resolving
// accountId from the order row itself - cancelOrderByAccountId needs an
// accountId, and the test only has the order id in scope at the point it
// schedules the cancellation.
async function cancelOrderByAccountIdForOrder(
  orderId: string,
): ReturnType<typeof cancelOrderByAccountId> {
  const [order] = await db
    .select({ accountId: orders.accountId })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) throw new Error(`Order ${orderId} not found`);
  return cancelOrderByAccountId(order.accountId, orderId);
}
