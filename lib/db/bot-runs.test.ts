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
import {
  createBotRun,
  getActiveBotRunCount,
  getBotRunsForAccount,
  getLastBotWorkerRun,
  runBotWorker,
} from "./bot-runs";
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
    sql`truncate table transactions, orders, positions, bot_runs, accounts, limit_order_worker_runs, bot_worker_runs cascade`,
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
    // v2, not v1 - see lib/trading/bot-rule.ts's ACTIVE_RULE_ID/PARAMS and
    // STATE.md for why the entry threshold moved from 30 to 40.
    expect(row?.ruleId).toBe("rsi_pullback_uptrend_v2");
    expect(row?.ruleParams).toMatchObject({ rsiEntryThreshold: 40, rsiExitThreshold: 50 });
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

  // Every other test in this file mocks rsi()/sma() directly (see the top
  // of this file) so it can hand-pick their outputs without needing a real
  // price series - deliberately, since this file's job is the
  // ORCHESTRATION, not re-proving indicator math indicators.test.ts already
  // owns. This one test is the exception: it restores the REAL rsi()/sma()
  // implementations and feeds them a real 50-day close-price fixture, to
  // prove the actual WIRING between real indicator computation and the
  // selection pipeline (buildCandidates -> rankEligibleBotCandidates ->
  // tryEnterBotRun) - not just that the orchestration behaves correctly
  // when told "RSI is 25," but that a genuine price series producing
  // RSI(14)<30 and close>SMA(50) actually flows through correctly end to
  // end. The fixture itself is not a hand-authored "realistic chart" -
  // seeking that turned into a research question of its own (see the
  // comment below) - it's the output of a numerical search that directly
  // asked the real rsi()/sma() functions "is there any 50-value close
  // series satisfying both conditions," which is a stronger check than a
  // hand-tuned one: it exercises the literal boundary condition rather
  // than a comfortable interior point.
  it("enters using the REAL rsi()/sma() computation on a real qualifying close-price fixture, not mocked indicator outputs", async () => {
    const actualIndicators =
      await vi.importActual<typeof import("../trading/indicators")>("../trading/indicators");
    vi.mocked(rsi).mockImplementation(actualIndicators.rsi);
    vi.mocked(sma).mockImplementation(actualIndicators.sma);

    // Found via direct numerical search against the real rsi()/sma()
    // functions (not hand-authored) - see the comment above for why.
    // Confirmed independently before writing this test: RSI(14) = 29.56
    // (< 30) and the final close ($186.41) sits $0.44 above SMA(50)
    // ($185.97) - both conditions genuinely hold under the exact same
    // Wilder/simple-average math lib/trading/bot-rule.ts uses in production.
    //
    // Worth recording plainly: getting here took an exhaustive search -
    // 1000 days of real data across 18 liquid, actively-traded symbols
    // (including notoriously volatile names) turned up RSI(14)<30 on 436
    // separate days and NEVER once alongside close>SMA(50); hundreds of
    // thousands of hand-parametrized synthetic price paths (smooth
    // uptrends, choppy uptrends, old-dip-then-recovery, front-loaded
    // crashes, plateau-then-dip, single-day-crash) found zero qualifying
    // cases either, until direct numerical optimization over the full
    // 50-value array found one. That is itself a real, load-bearing
    // finding about this rule as specified, not just a fixture-hunting
    // inconvenience - see STATE.md.
    const closesCents = [
      10825, 10908, 10998, 11039, 11222, 11441, 11888, 12086, 12180, 12694, 12923, 13131, 14197,
      14812, 16447, 16625, 17132, 17733, 17776, 18669, 18693, 18892, 19495, 19937, 20093, 20385,
      21475, 21478, 21792, 22012, 22347, 23640, 23843, 23890, 23978, 23978, 23977, 23959, 23875,
      23842, 23425, 22812, 22393, 21856, 21562, 21206, 20964, 20891, 19785, 18641,
    ].map(BigInt);

    // Sanity-check the fixture itself before trusting the test built on
    // it - this is what would fail loudly (not silently pass a
    // meaningless test) if indicators.ts's own math ever changed under it.
    const rsiCheck = actualIndicators.rsi(closesCents, 14).at(-1);
    const smaCheck = actualIndicators.sma(closesCents, 50).at(-1);
    expect(rsiCheck).not.toBeNull();
    expect(smaCheck).not.toBeNull();
    expect(rsiCheck!).toBeLessThan(30);
    expect(Number(closesCents.at(-1))).toBeGreaterThan(smaCheck!);

    vi.mocked(fetchDailyBarsForSymbols).mockResolvedValue(
      new Map([["AAPL", closesCents.map((c) => bar(c, 1_000_000))]]),
    );
    vi.mocked(fetchQuotes).mockResolvedValue({
      quotes: new Map([
        [
          "AAPL",
          {
            symbol: "AAPL",
            bidCents: toCents("186.50"),
            askCents: toCents("187.00"),
            timestamp: new Date(),
          },
        ],
      ]),
      failedSymbols: [],
    });

    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    const created = await createBotRun({
      userId,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    if (!created.ok) throw new Error("setup failed");

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsEntered).toBe(1);

    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, created.runId));
    expect(run?.status).toBe("holding");
    expect(run?.selectedSymbol).toBe("AAPL");
    // $1000.00 / $187.00 ask = floor(5.34...) = 5 shares.
    expect(run?.entryQuantity).toBe(5);
    expect(run?.entryTotalCents).toBe(toCents("935.00")); // 5 * $187.00

    const runOrders = await db.select().from(orders).where(eq(orders.botRunId, created.runId));
    const buyOrder = runOrders.find((order) => order.side === "buy");
    expect(buyOrder?.status).toBe("filled");
    expect(buyOrder?.type).toBe("market");
    expect(buyOrder?.quantity).toBe(5);
    expect(buyOrder?.filledPriceCents).toBe(toCents("187.00"));

    const sellOrder = runOrders.find((order) => order.side === "sell");
    expect(sellOrder?.status).toBe("pending");
    expect(sellOrder?.type).toBe("limit");
    expect(sellOrder?.quantity).toBe(5);
    // ($935.00 entry + $50.00 target) / 5 shares = $197.00 exactly.
    expect(sellOrder?.limitPriceCents).toBe(toCents("197.00"));

    await assertLedgerBalances(account.id);
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

  // The other exit tests each make exactly one condition true, which
  // proves that condition triggers correctly but doesn't touch the
  // PRIORITY ordering at all - trivially, only one thing can fire when
  // only one thing is true. This test is the one that actually exercises
  // priority: stop-loss is hit AND RSI has independently recovered above
  // the exit threshold, at the same moment, on the same cycle. The stated
  // priority (stop-loss checked first) must win - if the priority order in
  // monitorOneBotRun were ever accidentally reordered, this is the test
  // that would catch it; the isolated single-condition tests would not.
  it("resolves in favor of stop-loss when the rule's own RSI-recovery exit is ALSO true on the same cycle", async () => {
    const userId = randomUUID();
    const { runId, accountId, targetOrderId } = await createHoldingRun(
      userId,
      toCents("50.00"),
      toCents("30.00"),
    );

    // Bid $96.00 -> stop-loss condition (-$40, past the $30 threshold).
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
    // RSI recovered above 50 -> the rule's own exit condition is ALSO true
    // this same cycle, independently of price.
    vi.mocked(fetchDailyBarsForSymbols).mockResolvedValue(
      new Map([["AAPL", [bar(toCents("96.00"), 1_000_000)]]]),
    );
    vi.mocked(rsi).mockReturnValue([65]);

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsClosed).toBe(1);

    const [cancelledTarget] = await db.select().from(orders).where(eq(orders.id, targetOrderId));
    expect(cancelledTarget?.status).toBe("cancelled");

    // Exactly one exit order, not two - confirms only one exit PATH acted,
    // not that both conditions each independently tried to place a sell.
    const exitOrders = await db
      .select()
      .from(orders)
      .where(and(eq(orders.botRunId, runId), eq(orders.side, "sell"), eq(orders.type, "market")));
    expect(exitOrders).toHaveLength(1);

    const [run] = await db.select().from(botRuns).where(eq(botRuns.id, runId));
    expect(run?.status).toBe("closed_stop_loss"); // not closed_rule_exit
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

describe("runBotWorker - invocation logging", () => {
  // The whole point of this table: distinguishing "the worker ran and
  // found nothing to do" from "the worker didn't run at all" - both looked
  // identical from inside this app before it existed, since neither
  // runSelectionCycle nor runMonitoringCycle wrote anything when there was
  // no active bot_runs row to act on.
  it("records a run even when there are no selecting/holding bot_runs to act on", async () => {
    const before = new Date();

    const outcome = await runBotWorker(new Date());

    expect(outcome).toEqual({
      ok: true,
      counts: {
        runsConsideredForSelection: 0,
        runsEntered: 0,
        runsFailedNoAffordableCandidate: 0,
        runsMonitored: 0,
        runsClosed: 0,
      },
    });

    const lastRun = await getLastBotWorkerRun();
    expect(lastRun?.status).toBe("succeeded");
    expect(lastRun?.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(lastRun?.finishedAt).not.toBeNull();
    expect(lastRun).toMatchObject({
      runsConsideredForSelection: 0,
      runsEntered: 0,
      runsFailedNoAffordableCandidate: 0,
      runsMonitored: 0,
      runsClosed: 0,
      errorMessage: null,
    });
  });

  it("records the real counts from a successful invocation, matching what the route itself returns", async () => {
    const userId = randomUUID();
    await createBotRun({
      userId,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    mockEligibleCandidate();

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsEntered).toBe(1);

    const lastRun = await getLastBotWorkerRun();
    expect(lastRun).toMatchObject({
      status: "succeeded",
      runsConsideredForSelection: outcome.counts.runsConsideredForSelection,
      runsEntered: outcome.counts.runsEntered,
      runsFailedNoAffordableCandidate: outcome.counts.runsFailedNoAffordableCandidate,
      runsMonitored: outcome.counts.runsMonitored,
      runsClosed: outcome.counts.runsClosed,
    });
  });

  it("marks the run failed with the real error message when a cycle throws", async () => {
    const userId = randomUUID();
    await createBotRun({
      userId,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    // A selecting run must exist for runSelectionCycle to reach the Alpaca
    // calls at all (it short-circuits before them otherwise) - see the test
    // above.
    vi.mocked(fetchDailyBarsForSymbols).mockRejectedValue(new Error("Alpaca is down"));
    vi.mocked(fetchQuotes).mockResolvedValue({ quotes: new Map(), failedSymbols: [] });

    const outcome = await runBotWorker(new Date());

    expect(outcome).toEqual({ ok: false, error: "Alpaca is down" });

    const lastRun = await getLastBotWorkerRun();
    expect(lastRun?.status).toBe("failed");
    expect(lastRun?.errorMessage).toBe("Alpaca is down");
    expect(lastRun?.finishedAt).not.toBeNull();
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

describe("getActiveBotRunCount", () => {
  it("counts only 'selecting' and 'holding' runs, not closed or failed ones", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    mockNoEligibleCandidates();
    const stillSelecting = await createBotRun({
      userId,
      capitalCents: toCents("500.00"),
      profitTarget: { type: "dollar", valueCents: toCents("20.00") },
      stopLoss: { type: "dollar", valueCents: toCents("20.00") },
    });
    if (!stillSelecting.ok) throw new Error("setup failed");

    await db.insert(botRuns).values({
      accountId: account.id,
      status: "closed_target",
      ruleId: "rsi_pullback_uptrend_v1",
      ruleParams: { rsiPeriod: 14 },
      capitalCents: toCents("500.00"),
      profitTargetType: "dollar",
      profitTargetValueCents: toCents("20.00"),
      stopLossType: "dollar",
      stopLossValueCents: toCents("20.00"),
      realizedPnlCents: toCents("20.00"),
      closedAt: new Date(),
    });

    expect(await getActiveBotRunCount(account.id)).toBe(1);
  });

  it("is zero for an account with no bot runs at all", async () => {
    const account = await getOrCreateAccount(randomUUID());
    expect(await getActiveBotRunCount(account.id)).toBe(0);
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
