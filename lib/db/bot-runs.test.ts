import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar } from "../market/alpaca";
import { fetchDailyBarsForSymbols, fetchQuotes } from "../market/alpaca";
import { isApproachingMarketClose } from "../trading/bot-day-expiry";
import { rollingHigh, rsi, sma } from "../trading/indicators";
import {
  BREAKOUT_52WK_HIGH_V1_ID,
  GOLDEN_CROSS_V1_ID,
  RSI_PULLBACK_UPTREND_V2_ID,
} from "../trading/bot-rule";
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
import { accounts, botRuns, orders, positions } from "./schema";
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
vi.mock("../trading/indicators", () => ({
  rsi: vi.fn(),
  sma: vi.fn(),
  rollingHigh: vi.fn(),
  DEFAULT_RSI_PERIOD: 14,
}));

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

// Same AAPL quote/bar setup as mockEligibleCandidate, but the sma() mock
// distinguishes its calls by period (rsi_pullback's own SMA(50) check vs.
// golden_cross's fast SMA(20)/slow SMA(50)) so AAPL genuinely qualifies
// under BOTH rule families at once - needed to prove runSelectionCycle's
// per-ruleId grouping actually computes two independent ranked lists,
// rather than two runs happening to share one list under different labels.
// A single vi.fn().mockReturnValue(...) can't do this: every call would
// return the identical array regardless of period, which would make
// golden_cross's smaFast > smaSlow comparison always false (fast and slow
// would always read as equal).
function mockEligibleForBothRuleFamilies(): void {
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
  vi.mocked(rsi).mockReturnValue([25]); // oversold - satisfies rsi_pullback's own RSI<40 check
  vi.mocked(sma).mockImplementation((_closes, period) => {
    if (period === 20) return [9900, 10001]; // fast SMA: yesterday <= slow, today > slow - a fresh cross
    return [10000, 10000]; // period 50: both rsi_pullback's own SMA check and golden_cross's slow SMA
  });
}

// AAPL qualifies under golden_cross but NOT rsi_pullback: RSI 45 is not
// oversold (rsi_pullback needs <40), while the fast/slow SMAs show a fresh
// cross (golden_cross's own, unrelated condition). Exists specifically to
// prove a run's own stored ruleId/ruleParams actually govern its behavior -
// before this round's fix, every run was silently evaluated against one
// shared global rule regardless of what it had stored, which this
// combination would immediately expose (an rsi_pullback run would wrongly
// enter on a signal that isn't even its own).
function mockEligibleForGoldenCrossOnly(): void {
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
  vi.mocked(rsi).mockReturnValue([45]); // not oversold - rsi_pullback must NOT fire on this
  vi.mocked(sma).mockImplementation((_closes, period) => {
    if (period === 20) return [9900, 10001]; // fast SMA: a fresh cross above the slow SMA
    return [10000, 10000];
  });
}

// AAPL qualifies under breakout_52wk_high_v1 only: RSI 80 fails
// rsi_pullback, the period-20/50 SMAs are flat (fails golden_cross), and
// the period-365 rollingHigh/SMA show a genuine new high with a rising
// trend (breakout's own, unrelated condition). Same isolation-proof intent
// as mockEligibleForGoldenCrossOnly above, extended to the third family.
function mockEligibleForBreakoutOnly(): void {
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
  vi.mocked(rsi).mockReturnValue([80]); // not oversold - rsi_pullback must NOT fire on this
  vi.mocked(sma).mockImplementation((_closes, period) => {
    if (period === 365) {
      // buildCandidates reads today's value at .at(-1) and the lagged
      // value 20 (risingLookbackDays) positions further back at
      // .at(-21) - needs at least 21 elements for both to resolve.
      // Lagged (index 0) = 9900, today (index 20) = 10001: rising.
      return [9900, ...Array(19).fill(9950), 10001];
    }
    return [10000, 10000]; // periods 20/50 flat - golden_cross must NOT fire on this
  });
  // Yesterday's rolling 365-day high (.at(-2)) = 9800 - today's close
  // ($105.00 = 10500) exceeds it, a genuine new high.
  vi.mocked(rollingHigh).mockReturnValue([9800, 10000]);
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
  vi.mocked(rollingHigh).mockReset();
  // Default: no rolling-high data available at all - breakout's own
  // signal group ends up null (see buildCandidates in bot-runs.ts), the
  // same "not eligible, not a crash" treatment as any other family with
  // insufficient history. Tests that need breakout to actually qualify
  // override this explicitly (see mockEligibleForBreakoutOnly).
  vi.mocked(rollingHigh).mockReturnValue([]);
  await db.execute(
    sql`truncate table transactions, orders, positions, bot_runs, accounts, limit_order_worker_runs, bot_worker_runs cascade`,
  );
});

describe("createBotRun", () => {
  it("rejects zero or negative capital", async () => {
    const userId = randomUUID();
    const result = await createBotRun({
      userId,
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db.select().from(botRuns).where(eq(botRuns.id, result.runId));
    expect(row?.status).toBe("selecting");
    // v2, not v1 - see lib/trading/bot-rule.ts's AVAILABLE_STRATEGIES and
    // STATE.md for why the entry threshold moved from 30 to 40.
    expect(row?.ruleId).toBe("rsi_pullback_uptrend_v2");
    expect(row?.ruleParams).toMatchObject({ rsiEntryThreshold: 40, rsiExitThreshold: 50 });
  });

  it("rejects an unrecognized rule id, not silently falling back to any default", async () => {
    const userId = randomUUID();
    const result = await createBotRun({
      userId,
      ruleId: "not_a_real_strategy",
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    expect(result).toEqual({ ok: false, reason: "invalid_rule_id" });
  });
});

describe("runBotWorker - selection cycle", () => {
  it("enters a run when a watchlist candidate qualifies, tagging the entry order and placing a resting profit-target sell", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    const created = await createBotRun({
      userId,
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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

  // The direct regression test for this round's fix: before it, every run
  // was evaluated against one shared global rule no matter what it had
  // stored in ruleId/ruleParams - two runs with genuinely different rules
  // would have behaved identically. Here, only golden_cross's own condition
  // is true for AAPL; rsi_pullback's is deliberately false. If either run
  // read the wrong rule (or a shared one), the rsi_pullback run would
  // wrongly enter too.
  it("each run acts on its OWN stored ruleId/ruleParams, not a shared global rule", async () => {
    const userId = randomUUID();
    const rsiPullbackRun = await createBotRun({
      userId,
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    const goldenCrossRun = await createBotRun({
      userId,
      ruleId: GOLDEN_CROSS_V1_ID,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    if (!rsiPullbackRun.ok || !goldenCrossRun.ok) throw new Error("setup failed");

    mockEligibleForGoldenCrossOnly();

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsEntered).toBe(1);

    const [rsiRow] = await db.select().from(botRuns).where(eq(botRuns.id, rsiPullbackRun.runId));
    const [goldenRow] = await db.select().from(botRuns).where(eq(botRuns.id, goldenCrossRun.runId));
    expect(rsiRow?.status).toBe("selecting"); // its own rule genuinely never fired
    expect(goldenRow?.status).toBe("holding");
    expect(goldenRow?.selectedSymbol).toBe("AAPL");
  });

  it("enters a breakout_52wk_high_v1 run on a genuine new 365-day high with a rising SMA, while a sibling rsi_pullback run on the same cycle does not", async () => {
    const userId = randomUUID();
    const rsiPullbackRun = await createBotRun({
      userId,
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    const breakoutRun = await createBotRun({
      userId,
      ruleId: BREAKOUT_52WK_HIGH_V1_ID,
      capitalCents: toCents("1000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("50.00") },
      stopLoss: { type: "dollar", valueCents: toCents("30.00") },
    });
    if (!rsiPullbackRun.ok || !breakoutRun.ok) throw new Error("setup failed");

    mockEligibleForBreakoutOnly();

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);
    expect(outcome.counts.runsEntered).toBe(1);

    const [rsiRow] = await db.select().from(botRuns).where(eq(botRuns.id, rsiPullbackRun.runId));
    const [breakoutRow] = await db.select().from(botRuns).where(eq(botRuns.id, breakoutRun.runId));
    expect(rsiRow?.status).toBe("selecting"); // its own rule genuinely never fired
    expect(breakoutRow?.status).toBe("holding");
    expect(breakoutRow?.selectedSymbol).toBe("AAPL");
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
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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
    ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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

// Research spike for the multi-strategy proposal (see STATE.md): every
// bot_run draws from the same account's cash, and once more than one
// strategy can be active at once, two runs can genuinely compete for it or
// both land on the same symbol at once. These prove the underlying
// account/position mutation layer already handles both cases correctly
// TODAY, using tryEnterBotRun's real lock discipline (bot_run row, then
// account row - same order documented as an invariant elsewhere in this
// file) - not a new mechanism built for multi-strategy, just confirmed to
// already generalize to it. Neither test depends on a run's own ruleId
// actually changing its entry/exit behavior, because nothing reads
// ruleId/ruleParams per-run yet (see the proposal) - both runs behave
// identically under ACTIVE_RULE_PARAMS regardless of what's stored.
describe("multiple concurrent bot runs sharing one account", () => {
  // A first attempt at this test used two genuinely concurrent
  // runBotWorker() calls, each seeing both runs and processing them
  // sequentially within itself - and it passed even after the account-row
  // lock in tryEnterBotRun was deliberately removed. Root cause, found by
  // doing exactly what this file's own Gotchas call for (break the thing
  // being protected and check whether the test notices, not just reason
  // that it should): with only two runs and no ORDER BY, both invocations
  // visit them in the same order, so the bot_run-row lock alone ends up
  // serializing the two entries indirectly - by the time either invocation
  // reaches the second run, the first run's account update has *already*
  // committed, so even a plain unlocked read sees the correct post-commit
  // balance. That topology never actually forces two DIFFERENT runs'
  // account-mutation sections to overlap. Replaced with the same direct,
  // deterministic technique orders.test.ts already uses to prove Postgres
  // row locking ("a second SELECT ... FOR UPDATE on the same row blocks
  // until the first transaction ends"): hold the account row locked (and
  // spending from it) via a raw connection, and confirm runBotWorker's own
  // entry attempt genuinely blocks on that lock and then correctly re-reads
  // the post-hold balance, rather than racing past it or working from a
  // stale read.
  it("a bot entry genuinely blocks on the account row's lock, held by a concurrent spender, and correctly sees the post-hold balance afterward", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId); // $100,000.00 starting cash
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (!testDatabaseUrl) {
      throw new Error("Missing TEST_DATABASE_URL");
    }

    // Nominally sized to fully afford $80,000 (800 shares @ $100.00 ask) -
    // affordable against the account's real starting balance, but NOT
    // against the $40,000 that will actually remain once the raw
    // connection's held transaction has spent $60,000 of it. If the entry
    // incorrectly used a stale pre-hold balance (or didn't wait for the
    // lock at all), it would wrongly succeed; if it correctly waits and
    // re-reads, it must reject as insufficient_funds.
    const run = await createBotRun({
      userId,
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
      capitalCents: toCents("80000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("2000.00") },
      stopLoss: { type: "dollar", valueCents: toCents("2000.00") },
    });
    if (!run.ok) throw new Error("setup failed");

    mockEligibleCandidate(); // AAPL at ask $100.00 / bid $99.50

    const rawSql = postgres(testDatabaseUrl, { prepare: false });
    try {
      const start = Date.now();
      let workerStartedAfterMs: number | null = null;

      const rawHold = rawSql.begin(async (tx) => {
        await tx`select * from accounts where id = ${account.id} for update`;
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Simulates a concurrent spend - another bot run's entry, or a
        // human placing an ordinary trade - while this transaction still
        // holds the lock. Whatever the account looks like when this
        // commits is what runBotWorker's own entry attempt must see, not
        // whatever it looked like before this started. Records a matching
        // transactions row too (a real concurrent spend always would),
        // so assertLedgerBalances below stays a meaningful check rather
        // than something this raw simulation has to skip.
        // postgres.js's raw tagged-template query has no bigint overload -
        // pass every cents value through as a string, same convention this
        // app already uses at every other bigint-crossing boundary.
        const spendCents = toCents("60000.00");
        const newBalance = (account.cashCents - spendCents).toString();
        await tx`update accounts set cash_cents = ${newBalance} where id = ${account.id}`;
        await tx`insert into transactions (account_id, kind, amount_cents, balance_after_cents)
                  values (${account.id}, 'buy', ${(-spendCents).toString()}, ${newBalance})`;
      });

      // Give the raw hold a head start so it acquires the lock first.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const workerRun = (async () => {
        workerStartedAfterMs = Date.now() - start;
        return runBotWorker(new Date());
      })();

      const [, outcome] = await Promise.all([rawHold, workerRun]);
      if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);

      if (workerStartedAfterMs === null) throw new Error("worker never started");
      // Started well before the 300ms hold released (proving it was
      // actually blocked waiting on the lock, not conveniently scheduled
      // to run after) - the real proof is in the outcome below, not this
      // timing alone.
      expect(workerStartedAfterMs).toBeLessThan(300);

      const [updatedRun] = await db.select().from(botRuns).where(eq(botRuns.id, run.runId));
      // Correctly rejected - $40,000 real remaining cash can't cover the
      // $80,000 fill, which it could only know by waiting for the lock and
      // re-reading, not by working from the $100,000 balance that existed
      // when this run was created or when the worker cycle started.
      expect(updatedRun?.status).toBe("selecting");

      const [updatedAccount] = await db.select().from(accounts).where(eq(accounts.id, account.id));
      // Debited exactly the raw hold's $60,000 - not further debited by a
      // bot entry that should have been rejected, not restored either.
      expect(account.cashCents - (updatedAccount?.cashCents ?? 0n)).toBe(toCents("60000.00"));

      await assertLedgerBalances(account.id);
    } finally {
      await rawSql.end();
    }
  });

  it("two different runs entering the same symbol at once produce one correctly-merged position, with each run's own entry bookkeeping staying independent", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    // Plenty of cash for both this time - the property under test here is
    // position-merging correctness, not cash contention (see the sibling
    // test above for that).
    //
    // Genuinely different rule ids, each chosen at creation (now that
    // createBotRun actually accepts and validates one) - the real scenario
    // this guards against is two DIFFERENT strategies each independently
    // deciding AAPL qualifies right now. This also exercises the
    // per-ruleId grouping in runSelectionCycle for real: two distinct
    // ranked lists, computed from two distinct parsed ruleParams, both
    // needing to independently include AAPL - not just two runs sharing
    // one shared list under different labels. The account/position
    // mutation layer neither reads nor cares about ruleId, which is what
    // this test confirms still holds once two genuinely different rules
    // both fire on the same symbol at once.
    const runA = await createBotRun({
      userId,
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
      capitalCents: toCents("10000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("500.00") },
      stopLoss: { type: "dollar", valueCents: toCents("300.00") },
    });
    const runB = await createBotRun({
      userId,
      ruleId: GOLDEN_CROSS_V1_ID,
      capitalCents: toCents("20000.00"),
      profitTarget: { type: "dollar", valueCents: toCents("500.00") },
      stopLoss: { type: "dollar", valueCents: toCents("300.00") },
    });
    if (!runA.ok || !runB.ok) throw new Error("setup failed");

    mockEligibleForBothRuleFamilies(); // AAPL qualifies under rsi_pullback AND golden_cross at once

    const outcome = await runBotWorker(new Date());
    if (!outcome.ok) throw new Error(`worker failed: ${outcome.error}`);

    const [rowA] = await db.select().from(botRuns).where(eq(botRuns.id, runA.runId));
    const [rowB] = await db.select().from(botRuns).where(eq(botRuns.id, runB.runId));
    expect(rowA?.status).toBe("holding");
    expect(rowB?.status).toBe("holding");

    // runA: $10,000 / $100.00 = 100 shares. runB: $20,000 / $100.00 = 200
    // shares. Each run's OWN bookkeeping reflects only its own fill.
    expect(rowA?.entryQuantity).toBe(100);
    expect(rowA?.entryTotalCents).toBe(toCents("10000.00"));
    expect(rowB?.entryQuantity).toBe(200);
    expect(rowB?.entryTotalCents).toBe(toCents("20000.00"));

    // One shared position, not two - correctly merged: 300 shares total,
    // both bought at the same $100.00 ask, so the average cost is still
    // exactly $100.00.
    const positionRows = await db
      .select()
      .from(positions)
      .where(and(eq(positions.accountId, account.id), eq(positions.symbol, "AAPL")));
    expect(positionRows).toHaveLength(1);
    expect(positionRows[0]?.quantity).toBe(300);
    expect(positionRows[0]?.avgCostCents).toBe(toCents("100.00"));

    await assertLedgerBalances(account.id);
  });
});

describe("getBotRunsForAccount", () => {
  it("returns an account's runs, newest first", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    mockNoEligibleCandidates();

    const first = await createBotRun({
      userId,
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
      capitalCents: toCents("500.00"),
      profitTarget: { type: "dollar", valueCents: toCents("20.00") },
      stopLoss: { type: "dollar", valueCents: toCents("20.00") },
    });
    const second = await createBotRun({
      userId,
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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
      ruleId: RSI_PULLBACK_UPTREND_V2_ID,
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
