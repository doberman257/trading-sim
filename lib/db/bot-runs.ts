import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  fetchDailyBarsForSymbols,
  fetchQuote,
  fetchQuotes,
  NoTwoSidedQuoteError,
  type Bar,
} from "../market/alpaca";
import { BOT_WATCHLIST_SYMBOLS } from "../market/bot-watchlist";
import { isApproachingMarketClose } from "../trading/bot-day-expiry";
import { computeBotRunRealizedPnl } from "../trading/bot-pnl";
import {
  AVAILABLE_STRATEGIES,
  BREAKOUT_52WK_HIGH_V1_PARAMS,
  GOLDEN_CROSS_V1_PARAMS,
  parseRuleParams,
  RSI_PULLBACK_UPTREND_V2_PARAMS,
  ruleShouldExit,
  type BotRuleParams,
  type RuleExitEvaluation,
} from "../trading/bot-rule";
import { rankEligibleBotCandidates, type BotCandidate } from "../trading/bot-selection";
import { computeBotOrderQuantity } from "../trading/bot-sizing";
import {
  computeProfitTargetLimitPriceCents,
  isProfitTargetHit,
  isStopLossHit,
  validateTargetConfig,
  type TargetConfig,
} from "../trading/bot-targets";
import { executeMarketOrder } from "../trading/execute";
import { canPlaceLimitOrder } from "../trading/limit-reservation";
import type { Cents } from "../trading/money";
import { rollingHigh, rsi, sma } from "../trading/indicators";
import { valuePosition } from "../trading/pnl";
import type { AccountState, Quote, RejectReason } from "../trading/types";
import { getOrCreateAccount, loadAccountState } from "./accounts";
import { db, type DbTransaction } from "./client";
import {
  applyFillEffects,
  cancelOrderByAccountId,
  getPendingLimitOrdersForAccount,
  recordFillTransaction,
} from "./orders";
import { accounts, botRuns, botWorkerRuns, orders } from "./schema";

// Must comfortably cover breakout_52wk_high_v1's own need - the largest of
// any rule family's: a 365-trading-day rolling high/SMA PLUS a 20-trading-day
// rising-SMA lookback, so 385 trading days minimum, for both the selection
// cycle's candidate-building AND the monitoring cycle's own exit check on an
// already-holding breakout run (both call fetchDailyBarsForSymbols with this
// same constant). Scaled via this app's own empirically-confirmed
// 20-trading-day/~30-calendar-day ratio for the bars endpoint (see STATE.md)
// - 385 trading days * 1.5 =~ 578 calendar days - with real margin on top for
// holidays/weekends variance, not cut close to the theoretical minimum.
// `fetchDailyBarsForSymbols`'s own chunking already handles requests this
// size for the full ~517-symbol watchlist (proven during the breakout
// historical scan, which fetched 1000 calendar days across the same
// universe), so this is a correctness floor, not a request-size risk.
const SELECTION_LOOKBACK_DAYS = 650;

type BotRunRow = typeof botRuns.$inferSelect;

type TargetColumns = {
  type: "dollar" | "percent";
  valueCents: Cents | null;
  basisPoints: number | null;
};

function targetConfigToColumns(config: TargetConfig): TargetColumns {
  return config.type === "dollar"
    ? { type: "dollar", valueCents: config.valueCents, basisPoints: null }
    : { type: "percent", valueCents: null, basisPoints: config.basisPoints };
}

// The inverse of targetConfigToColumns - throws on a malformed pair rather
// than silently defaulting, the same "narrow via a real error" discipline
// getPendingLimitOrdersForAccount already applies to a limit order's own
// nullable limitPriceCents: exactly one of valueCents/basisPoints being set
// is a schema invariant every bot run insert already guarantees, so a
// mismatch here means that invariant broke, not a normal case to route
// around.
function columnsToTargetConfig(
  type: "dollar" | "percent",
  valueCents: Cents | null,
  basisPoints: number | null,
): TargetConfig {
  if (type === "dollar") {
    if (valueCents === null) {
      throw new Error("Bot run target config: dollar type is missing valueCents");
    }
    return { type: "dollar", valueCents };
  }
  if (basisPoints === null) {
    throw new Error("Bot run target config: percent type is missing basisPoints");
  }
  return { type: "percent", basisPoints };
}

export type CreateBotRunInput = {
  userId: string;
  ruleId: string;
  capitalCents: Cents;
  profitTarget: TargetConfig;
  stopLoss: TargetConfig;
  timeHorizonDeadlineAt?: Date | null;
};

export type CreateBotRunResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      reason: "invalid_capital" | "invalid_profit_target" | "invalid_stop_loss" | "invalid_rule_id";
    };

// Validates and inserts a new "selecting" run - does not select a symbol or
// place any order itself. The worker's own selection cycle (see
// runBotWorker below) picks it up on its next tick; the Route Handler that
// calls this may also trigger one cycle immediately for faster feedback
// (see app/api/bot/runs/route.ts), but that is a caller choice, not
// something this function does on its own.
export async function createBotRun(input: CreateBotRunInput): Promise<CreateBotRunResult> {
  const strategy = AVAILABLE_STRATEGIES[input.ruleId];
  if (!strategy) {
    return { ok: false, reason: "invalid_rule_id" };
  }
  if (input.capitalCents <= 0n) {
    return { ok: false, reason: "invalid_capital" };
  }
  if (validateTargetConfig(input.profitTarget, input.capitalCents) !== null) {
    return { ok: false, reason: "invalid_profit_target" };
  }
  if (validateTargetConfig(input.stopLoss, input.capitalCents) !== null) {
    return { ok: false, reason: "invalid_stop_loss" };
  }

  const account = await getOrCreateAccount(input.userId);
  const profitTargetColumns = targetConfigToColumns(input.profitTarget);
  const stopLossColumns = targetConfigToColumns(input.stopLoss);

  const [created] = await db
    .insert(botRuns)
    .values({
      accountId: account.id,
      ruleId: input.ruleId,
      ruleParams: strategy.params,
      capitalCents: input.capitalCents,
      profitTargetType: profitTargetColumns.type,
      profitTargetValueCents: profitTargetColumns.valueCents,
      profitTargetBasisPoints: profitTargetColumns.basisPoints,
      stopLossType: stopLossColumns.type,
      stopLossValueCents: stopLossColumns.valueCents,
      stopLossBasisPoints: stopLossColumns.basisPoints,
      timeHorizonDeadlineAt: input.timeHorizonDeadlineAt ?? null,
    })
    .returning({ id: botRuns.id });

  if (!created) {
    throw new Error("Failed to insert bot run");
  }

  return { ok: true, runId: created.id };
}

export type BotRunForDisplay = {
  id: string;
  status: BotRunRow["status"];
  ruleId: string;
  capitalCents: Cents;
  selectedSymbol: string | null;
  entryTotalCents: Cents | null;
  entryQuantity: number | null;
  realizedPnlCents: Cents | null;
  createdAt: Date;
  closedAt: Date | null;
};

export async function getBotRunsForAccount(accountId: string): Promise<BotRunForDisplay[]> {
  return db
    .select({
      id: botRuns.id,
      status: botRuns.status,
      ruleId: botRuns.ruleId,
      capitalCents: botRuns.capitalCents,
      selectedSymbol: botRuns.selectedSymbol,
      entryTotalCents: botRuns.entryTotalCents,
      entryQuantity: botRuns.entryQuantity,
      realizedPnlCents: botRuns.realizedPnlCents,
      createdAt: botRuns.createdAt,
      closedAt: botRuns.closedAt,
    })
    .from(botRuns)
    .where(eq(botRuns.accountId, accountId))
    .orderBy(desc(botRuns.createdAt));
}

// "Active" means still in flight - selecting a candidate or holding a
// position - not yet resolved to any of the closed/failed terminal states.
// This is what the header's UserMenu (rendered on every authenticated page,
// not just the dashboard) shows as a quick "N active bot runs" status, since
// the bot panels themselves only render on the dashboard - a user browsing
// Discover or a stock page would otherwise have no visibility into whether
// a run is still working without navigating back.
export async function getActiveBotRunCount(accountId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(botRuns)
    .where(
      and(eq(botRuns.accountId, accountId), inArray(botRuns.status, ["selecting", "holding"])),
    );

  return row ? Number(row.count) : 0;
}

// One watchlist symbol's signals, built from a batched bars+quotes fetch -
// null when there isn't enough history yet (a symbol newly added to the
// watchlist) or no live quote right now, in which case it's simply excluded
// from candidates this cycle rather than treated as an error.
//
// All three rule families' signals are computed unconditionally for every
// candidate, using each family's one currently-registered period set
// (RSI_PULLBACK_UPTREND_V2_PARAMS / GOLDEN_CROSS_V1_PARAMS /
// BREAKOUT_52WK_HIGH_V1_PARAMS) - see BotCandidate's own comment in
// bot-selection.ts for why this is a plain data bag rather than computed
// lazily per rule-in-use. v1's rsi_pullback params share v2's
// rsiPeriod/smaPeriod (only the entry threshold differs), so these same
// signals correctly serve any run still recorded under v1 too.
//
// Each family's own group is null, independently, when there isn't enough
// bar history yet for THAT family's own indicators (golden_cross's
// SMA(50)-yesterday needs one more day of history than rsi_pullback's
// SMA(50)-today does, breakout's own SMA(365)-lagged needs 20 more days on
// top of that) - a candidate is only dropped entirely when NO family has
// usable data, not whenever any one alone is incomplete (see BotCandidate's
// own comment in bot-selection.ts for why that distinction matters).
function buildCandidates(
  symbols: readonly string[],
  barsMap: ReadonlyMap<string, Bar[]>,
  quotes: ReadonlyMap<string, Quote>,
): BotCandidate[] {
  const candidates: BotCandidate[] = [];

  for (const symbol of symbols) {
    const bars = barsMap.get(symbol);
    const quote = quotes.get(symbol);
    if (!bars || bars.length === 0 || !quote) continue;

    const closes = bars.map((bar) => bar.closeCents);
    const latestClose = closes.at(-1);
    const latestVolume = bars.at(-1)?.volume;
    if (latestClose === undefined || latestVolume === undefined) continue;

    const latestRsi = rsi(closes, RSI_PULLBACK_UPTREND_V2_PARAMS.rsiPeriod).at(-1);
    const latestSma = sma(closes, RSI_PULLBACK_UPTREND_V2_PARAMS.smaPeriod).at(-1);
    const rsiPullback =
      latestRsi != null && latestSma != null ? { rsi: latestRsi, sma: latestSma } : null;

    const fastSmaSeries = sma(closes, GOLDEN_CROSS_V1_PARAMS.fastPeriod);
    const slowSmaSeries = sma(closes, GOLDEN_CROSS_V1_PARAMS.slowPeriod);
    const smaFast = fastSmaSeries.at(-1);
    const smaFastYesterday = fastSmaSeries.at(-2);
    const smaSlow = slowSmaSeries.at(-1);
    const smaSlowYesterday = slowSmaSeries.at(-2);
    const goldenCross =
      smaFast != null && smaFastYesterday != null && smaSlow != null && smaSlowYesterday != null
        ? { smaFast, smaFastYesterday, smaSlow, smaSlowYesterday }
        : null;

    // priorHigh is YESTERDAY's rolling high (the window ending the day
    // before today), not today's - today's own close is what must clear
    // it, so including today's own bar in the high it's compared against
    // would make a breakout partly measure itself.
    const highSeries = rollingHigh(closes, BREAKOUT_52WK_HIGH_V1_PARAMS.breakoutWindowDays);
    const priorHigh = highSeries.at(-2);
    const breakoutSmaSeries = sma(closes, BREAKOUT_52WK_HIGH_V1_PARAMS.breakoutWindowDays);
    const smaToday = breakoutSmaSeries.at(-1);
    const smaLagged = breakoutSmaSeries.at(-1 - BREAKOUT_52WK_HIGH_V1_PARAMS.risingLookbackDays);
    const breakout =
      priorHigh != null && smaToday != null && smaLagged != null
        ? { priorHigh, smaToday, smaLagged }
        : null;

    if (!rsiPullback && !goldenCross && !breakout) continue;

    candidates.push({
      symbol,
      bidCents: quote.bidCents,
      askCents: quote.askCents,
      volume: latestVolume,
      price: latestClose,
      rsiPullback,
      goldenCross,
      breakout,
    });
  }

  return candidates;
}

export type BotWorkerCounts = {
  runsConsideredForSelection: number;
  runsEntered: number;
  runsFailedNoAffordableCandidate: number;
  runsMonitored: number;
  runsClosed: number;
};

export type BotWorkerOutcome = { ok: true; counts: BotWorkerCounts } | { ok: false; error: string };

// The single entry point the bot worker route calls - see
// app/api/worker/bot-runs/route.ts. Same "safe under irregular invocation"
// discipline as runLimitOrderWorker: every decision below is a function of
// current state (each run's own status under its own lock, a fresh
// bars+quotes fetch), never of when this last ran.
//
// Records a bot_worker_runs row for every invocation, same insert-then-
// update pattern as runLimitOrderWorker - including when both cycles find
// nothing to do (selection/monitoring counts of zero are still a real,
// recorded fact: "the worker ran and found nothing," distinguishable from
// "the worker didn't run" only because this row exists at all). Purely an
// observability addition wrapped around the two cycles - neither
// runSelectionCycle nor runMonitoringCycle's own logic changes.
export async function runBotWorker(now: Date): Promise<BotWorkerOutcome> {
  const [run] = await db.insert(botWorkerRuns).values({}).returning({ id: botWorkerRuns.id });

  if (!run) {
    throw new Error("Failed to record a new bot_worker_runs row");
  }

  try {
    const selection = await runSelectionCycle(now);
    const monitoring = await runMonitoringCycle(now);
    const counts: BotWorkerCounts = {
      runsConsideredForSelection: selection.considered,
      runsEntered: selection.entered,
      runsFailedNoAffordableCandidate: selection.failedNoAffordableCandidate,
      runsMonitored: monitoring.monitored,
      runsClosed: monitoring.closed,
    };

    await db
      .update(botWorkerRuns)
      .set({ status: "succeeded", finishedAt: new Date(), ...counts })
      .where(eq(botWorkerRuns.id, run.id));

    return { ok: true, counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(botWorkerRuns)
      .set({ status: "failed", finishedAt: new Date(), errorMessage: message })
      .where(eq(botWorkerRuns.id, run.id));

    return { ok: false, error: message };
  }
}

export type LastBotWorkerRun = {
  startedAt: Date;
  finishedAt: Date | null;
  status: "running" | "succeeded" | "failed";
  runsConsideredForSelection: number | null;
  runsEntered: number | null;
  runsFailedNoAffordableCandidate: number | null;
  runsMonitored: number | null;
  runsClosed: number | null;
  errorMessage: string | null;
};

// The most recent invocation in ANY state, not just the last successful one
// - same reasoning as getLastLimitOrderWorkerRun: a stuck "running" row or a
// string of failures is exactly what app/api/worker/bot-status/route.ts
// exists to surface, so filtering to "succeeded" here would hide it.
export async function getLastBotWorkerRun(): Promise<LastBotWorkerRun | null> {
  const [latest] = await db
    .select()
    .from(botWorkerRuns)
    .orderBy(desc(botWorkerRuns.startedAt))
    .limit(1);

  return latest ?? null;
}

async function runSelectionCycle(
  now: Date,
): Promise<{ considered: number; entered: number; failedNoAffordableCandidate: number }> {
  const selectingRuns = await db.select().from(botRuns).where(eq(botRuns.status, "selecting"));
  if (selectingRuns.length === 0) {
    return { considered: 0, entered: 0, failedNoAffordableCandidate: 0 };
  }

  // One batched fetch for the whole watchlist, not one per run - the same
  // batching discipline every other multi-symbol read in this app follows.
  const [barsMap, quotesResult] = await Promise.all([
    fetchDailyBarsForSymbols([...BOT_WATCHLIST_SYMBOLS], SELECTION_LOOKBACK_DAYS),
    fetchQuotes([...BOT_WATCHLIST_SYMBOLS]),
  ]);
  const candidates = buildCandidates(BOT_WATCHLIST_SYMBOLS, barsMap, quotesResult.quotes);

  // Each run picks its own rule at creation time (see createBotRun) and
  // that choice must actually govern what it does here - ranking every
  // selecting run against one shared global rule (the bug this round
  // fixes) would mean a run's stored ruleId/ruleParams were pure decoration.
  // Grouped by distinct ruleId, not recomputed per run: two runs sharing
  // the same rule share the same ranked list, computed once.
  const rankedByRuleId = new Map<string, BotCandidate[]>();
  for (const run of selectingRuns) {
    if (rankedByRuleId.has(run.ruleId)) continue;
    const params = parseRuleParams(run.ruleParams);
    if (!params) continue; // unparseable/corrupt row - never matches any candidate this cycle
    rankedByRuleId.set(run.ruleId, rankEligibleBotCandidates(candidates, params));
  }

  let entered = 0;
  let failedNoAffordableCandidate = 0;

  for (const run of selectingRuns) {
    const ranked = rankedByRuleId.get(run.ruleId) ?? [];
    const outcome = await attemptEntryForRun(run, ranked, quotesResult.quotes, now);
    if (outcome === "entered") entered++;
    if (outcome === "failed_no_affordable_candidate") failedNoAffordableCandidate++;
  }

  return { considered: selectingRuns.length, entered, failedNoAffordableCandidate };
}

async function attemptEntryForRun(
  run: BotRunRow,
  rankedCandidates: readonly BotCandidate[],
  quotes: ReadonlyMap<string, Quote>,
  now: Date,
): Promise<"entered" | "no_candidate_yet" | "failed_no_affordable_candidate" | "already_resolved"> {
  let anyAffordable = false;

  for (const candidate of rankedCandidates) {
    const sizing = computeBotOrderQuantity(run.capitalCents, candidate.askCents);
    if (!sizing) continue;
    anyAffordable = true;

    const quote = quotes.get(candidate.symbol);
    if (!quote) continue; // built from this same map above; defensive only

    const attempt = await tryEnterBotRun(run.id, quote, sizing.quantity, now);
    if (attempt === "entered" || attempt === "already_resolved") {
      return attempt;
    }
    // "rejected" (a real-time stale_quote/market_closed/insufficient_funds)
    // - fall through and try the next ranked candidate this same cycle.
  }

  if (rankedCandidates.length === 0 || anyAffordable) {
    // Either nothing qualifies yet, or something qualified and was
    // affordable but every attempt hit a transient real-time rejection -
    // both retry-worthy next cycle, neither a terminal failure.
    return "no_candidate_yet";
  }

  // Eligible candidates exist, but the capital budget can't afford even one
  // share of any of them - a real, terminal outcome per the design brief,
  // not something waiting for another cycle will fix.
  const updated = await db
    .update(botRuns)
    .set({ status: "failed_no_affordable_candidate", closedAt: now })
    .where(and(eq(botRuns.id, run.id), eq(botRuns.status, "selecting")))
    .returning({ id: botRuns.id });

  return updated.length > 0 ? "failed_no_affordable_candidate" : "already_resolved";
}

// Claims one "selecting" run (via a row lock, re-checked after acquiring
// it - the same double-claim-prevention discipline as the limit-order
// worker's tryFillOneOrder) and, if the entry buy fills, immediately places
// the resting profit-target limit sell in the SAME transaction. Not built
// by calling placeMarketOrder/placeLimitOrder as black boxes: both manage
// their own transaction and account-row lock, and nesting a second
// db.transaction inside this one would hold two pooled connections open for
// one logical operation instead of one. Reuses applyFillEffects/
// recordFillTransaction directly instead - the same shared helpers
// placeMarketOrder and the limit-order worker already both use, so no money
// math is duplicated here either.
async function tryEnterBotRun(
  runId: string,
  quote: Quote,
  quantity: number,
  now: Date,
): Promise<"entered" | "rejected" | "already_resolved"> {
  return db.transaction(async (tx) => {
    const [lockedRun] = await tx.select().from(botRuns).where(eq(botRuns.id, runId)).for("update");

    if (!lockedRun || lockedRun.status !== "selecting") {
      return "already_resolved";
    }

    const [lockedAccount] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, lockedRun.accountId))
      .for("update");

    if (!lockedAccount) {
      throw new Error(`Account ${lockedRun.accountId} not found`);
    }

    const accountState = await loadAccountState(tx, lockedAccount.id);
    const result = executeMarketOrder(accountState, quote, "buy", quantity, now);

    if (!result.ok) {
      await tx.insert(orders).values({
        accountId: lockedAccount.id,
        symbol: quote.symbol,
        side: "buy",
        type: "market",
        quantity,
        status: "rejected",
        rejectReason: result.reason,
        botRunId: runId,
      });
      return "rejected";
    }

    const { fill } = result;

    const [insertedOrder] = await tx
      .insert(orders)
      .values({
        accountId: lockedAccount.id,
        symbol: quote.symbol,
        side: "buy",
        type: "market",
        quantity,
        status: "filled",
        filledPriceCents: fill.priceCents,
        filledAt: now,
        botRunId: runId,
      })
      .returning({ id: orders.id });

    if (!insertedOrder) {
      throw new Error("Failed to insert bot entry order");
    }

    await applyFillEffects(tx, lockedAccount.id, quote.symbol, fill);
    await recordFillTransaction(tx, lockedAccount.id, insertedOrder.id, "buy", fill);

    const newPosition = fill.newPosition;
    if (!newPosition) {
      throw new Error("Bot entry buy fill produced no new position - impossible for a buy");
    }

    await placeRestingProfitTarget(
      tx,
      lockedAccount.id,
      lockedRun,
      quote.symbol,
      {
        quantity: fill.quantity,
        totalCents: fill.totalCents,
        newCashCents: fill.newCashCents,
        newPosition,
      },
      accountState,
    );

    await tx
      .update(botRuns)
      .set({
        status: "holding",
        selectedSymbol: quote.symbol,
        entryTotalCents: fill.totalCents,
        entryQuantity: fill.quantity,
      })
      .where(eq(botRuns.id, runId));

    return "entered";
  });
}

// Places the resting profit-target limit sell right after the entry fill,
// in the same transaction - validated the exact same way a human's own
// limit order would be (canPlaceLimitOrder, against the POST-fill account
// state and every other pending order), not skipped just because this run
// just bought the shares itself. If the reservation math somehow says no
// (an unrelated pending sell on this exact symbol from elsewhere on the
// account, claimed before this fill), the run still proceeds to "holding"
// without a resting order - monitorOneBotRun's own isProfitTargetHit
// fallback still catches the profit-target exit in that case, just via a
// market sell instead of a resting limit.
async function placeRestingProfitTarget(
  tx: DbTransaction,
  accountId: string,
  run: BotRunRow,
  symbol: string,
  fill: {
    quantity: number;
    totalCents: Cents;
    newCashCents: Cents;
    newPosition: { quantity: number; avgCostCents: Cents };
  },
  preFillAccountState: AccountState,
): Promise<void> {
  const profitTarget = columnsToTargetConfig(
    run.profitTargetType,
    run.profitTargetValueCents,
    run.profitTargetBasisPoints,
  );
  const limitPriceCents = computeProfitTargetLimitPriceCents(
    fill.totalCents,
    fill.quantity,
    profitTarget,
  );

  const postFillAccountState: AccountState = {
    cashCents: fill.newCashCents,
    positions: new Map(preFillAccountState.positions).set(symbol, fill.newPosition),
  };
  const otherPendingOrders = await getPendingLimitOrdersForAccount(tx, accountId);
  const decision = canPlaceLimitOrder(
    postFillAccountState,
    { side: "sell", symbol, quantity: fill.quantity, limitPriceCents },
    otherPendingOrders,
  );

  if (!decision.ok) {
    return;
  }

  await tx.insert(orders).values({
    accountId,
    symbol,
    side: "sell",
    type: "limit",
    quantity: fill.quantity,
    limitPriceCents,
    status: "pending",
    botRunId: run.id,
  });
}

async function runMonitoringCycle(now: Date): Promise<{ monitored: number; closed: number }> {
  const holdingRuns = await db.select().from(botRuns).where(eq(botRuns.status, "holding"));
  if (holdingRuns.length === 0) {
    return { monitored: 0, closed: 0 };
  }

  const symbols = [
    ...new Set(
      holdingRuns
        .map((run) => run.selectedSymbol)
        .filter((symbol): symbol is string => symbol !== null),
    ),
  ];

  const [barsMap, quotesResult] = await Promise.all([
    fetchDailyBarsForSymbols(symbols, SELECTION_LOOKBACK_DAYS),
    fetchQuotes(symbols),
  ]);
  const closingSoon = isApproachingMarketClose(now);

  let closed = 0;
  for (const run of holdingRuns) {
    const didClose = await monitorOneBotRun(run, barsMap, quotesResult.quotes, closingSoon, now);
    if (didClose) closed++;
  }

  return { monitored: holdingRuns.length, closed };
}

// Builds the one RuleExitEvaluation a holding run's own rule needs, from
// freshly fetched bars - the exit-side counterpart to bot-selection.ts's
// buildEvaluation, but computed lazily per holding run (not unconditionally
// for the whole watchlist like buildCandidates) since only the one symbol
// each run actually holds matters here. Returns null when there isn't
// enough bar history for this rule's own period yet - the same "skip this
// cycle, try again next time" treatment buildCandidates gives an
// insufficient-history candidate, not a crash.
function computeRuleExitEvaluation(
  params: BotRuleParams,
  closes: readonly Cents[],
): RuleExitEvaluation | null {
  switch (params.kind) {
    case "rsi_pullback": {
      const latestRsi = rsi(closes, params.rsiPeriod).at(-1);
      if (latestRsi == null) return null;
      return { kind: "rsi_pullback", params, signals: { rsi: latestRsi } };
    }
    case "golden_cross": {
      const smaFast = sma(closes, params.fastPeriod).at(-1);
      const smaSlow = sma(closes, params.slowPeriod).at(-1);
      if (smaFast == null || smaSlow == null) return null;
      return { kind: "golden_cross", signals: { smaFast, smaSlow } };
    }
    case "breakout": {
      const smaToday = sma(closes, params.exitSmaPeriod).at(-1);
      const price = closes.at(-1);
      if (smaToday == null || price === undefined) return null;
      return { kind: "breakout", signals: { price, sma: smaToday } };
    }
  }
}

async function monitorOneBotRun(
  run: BotRunRow,
  barsMap: ReadonlyMap<string, Bar[]>,
  quotes: ReadonlyMap<string, Quote>,
  closingSoon: boolean,
  now: Date,
): Promise<boolean> {
  if (run.selectedSymbol === null || run.entryTotalCents === null || run.entryQuantity === null) {
    throw new Error(`Bot run ${run.id} is "holding" but missing its entry fields`);
  }
  const selectedSymbol = run.selectedSymbol;
  const entryTotalCents = run.entryTotalCents;
  const entryQuantity = run.entryQuantity;

  const [targetOrder] = await db
    .select({
      id: orders.id,
      status: orders.status,
      filledPriceCents: orders.filledPriceCents,
      quantity: orders.quantity,
    })
    .from(orders)
    .where(and(eq(orders.botRunId, run.id), eq(orders.side, "sell"), eq(orders.type, "limit")))
    .limit(1);

  if (targetOrder && targetOrder.status === "filled") {
    if (targetOrder.filledPriceCents === null) {
      throw new Error(`Filled target order ${targetOrder.id} is missing filledPriceCents`);
    }
    const exitTotalCents = targetOrder.filledPriceCents * BigInt(targetOrder.quantity);
    return closeAlreadyFilledBotRun(run.id, entryTotalCents, exitTotalCents, now);
  }

  const quote = quotes.get(selectedSymbol);
  if (!quote) {
    return false; // no live quote this cycle - try again next time
  }

  const avgCostCentsPerShare = entryTotalCents / BigInt(entryQuantity);
  const { unrealizedPnlCents } = valuePosition(avgCostCentsPerShare, quote.bidCents, entryQuantity);
  const stopLoss = columnsToTargetConfig(
    run.stopLossType,
    run.stopLossValueCents,
    run.stopLossBasisPoints,
  );
  const profitTarget = columnsToTargetConfig(
    run.profitTargetType,
    run.profitTargetValueCents,
    run.profitTargetBasisPoints,
  );

  // Priority among the four exit conditions, stated and deterministic, not
  // a judgment call - only one sell can actually happen per cycle, so a
  // tie needs a rule. Stop-loss (risk control) first; the profit-target
  // fallback next (only reachable when no resting order exists at all -
  // see placeRestingProfitTarget's own note); day-order expiry next; the
  // rule's own reversal signal last, since it's the weakest, most passive
  // of the four.
  let exitReason: BotRunAutoExitReason | null = null;

  if (isStopLossHit(unrealizedPnlCents, stopLoss, entryTotalCents)) {
    exitReason = "closed_stop_loss";
  } else if (!targetOrder && isProfitTargetHit(unrealizedPnlCents, profitTarget, entryTotalCents)) {
    exitReason = "closed_target";
  } else if (closingSoon) {
    exitReason = "closed_day_expiry";
  } else {
    const bars = barsMap.get(selectedSymbol);
    const closes = bars?.map((bar) => bar.closeCents) ?? [];
    const ruleParams = parseRuleParams(run.ruleParams);
    const evaluation = ruleParams ? computeRuleExitEvaluation(ruleParams, closes) : null;
    if (evaluation && ruleShouldExit(evaluation)) {
      exitReason = "closed_rule_exit";
    }
  }

  if (exitReason === null) {
    return false;
  }

  const outcome = await closeHoldingBotRunViaMarketSell(
    run,
    targetOrder ?? null,
    exitReason,
    quote,
    now,
  );
  return outcome.outcome === "closed";
}

// The monitoring cycle's own four automatic exit reasons - stop-loss/
// target/day-expiry are cross-cutting (apply regardless of which rule is
// active), rule_exit is the rule's own reversal signal. Kept as its own
// named type, distinct from BotRunExitReason below, since monitorOneBotRun
// only ever DECIDES one of these four - "closed_cancelled" is never a
// decision the monitoring cycle itself makes, only a user action.
type BotRunAutoExitReason =
  "closed_stop_loss" | "closed_target" | "closed_day_expiry" | "closed_rule_exit";

// Every terminal status a "holding" run can be closed into via a real
// market sell - the four automatic reasons above, plus a user-initiated
// cancellation. One shared type because closeHoldingBotRunViaMarketSell/
// tryExitBotRunViaMarketSell below are the exact same operation regardless
// of WHY the caller wants this run closed - only the final status column
// value differs.
type BotRunExitReason = BotRunAutoExitReason | "closed_cancelled";

// What actually happened when a holding run's own close-via-market-sell was
// attempted - richer than a plain boolean specifically because
// cancelBotRun (below) needs to report an honest, specific outcome to the
// user, not just "did or didn't close this cycle" the way monitorOneBotRun
// itself only needs.
type ExitBotRunOutcome =
  | { outcome: "closed"; realizedPnlCents: Cents }
  // The run resolved to some other terminal state before this attempt's own
  // lock could win the race - "already resolved" covers both a genuine
  // race (the monitoring cycle or the resting limit order's own fill beat
  // this attempt to it) and a plain repeat call (e.g. a user double-
  // clicking Cancel). finalStatus is whatever actually got written, read
  // back rather than guessed, so the caller can report the real reason.
  | {
      outcome: "already_resolved";
      finalStatus: BotRunRow["status"];
      realizedPnlCents: Cents | null;
    }
  | { outcome: "rejected"; reason: RejectReason };

// Bookkeeping-only close: the resting profit-target limit order already
// filled (the limit-order worker's own cycle did it, this cycle or an
// earlier one) - no new order to place here, just recording the outcome.
// Guarded by `status = 'holding'` in the WHERE, not just the id, so a
// second concurrent invocation reaching this same point is a harmless
// no-op rather than a double-write.
async function closeAlreadyFilledBotRun(
  runId: string,
  entryTotalCents: Cents,
  exitTotalCents: Cents,
  now: Date,
): Promise<boolean> {
  const realizedPnlCents = computeBotRunRealizedPnl(entryTotalCents, exitTotalCents);
  const updated = await db
    .update(botRuns)
    .set({ status: "closed_target", realizedPnlCents, closedAt: now })
    .where(and(eq(botRuns.id, runId), eq(botRuns.status, "holding")))
    .returning({ id: botRuns.id });
  return updated.length > 0;
}

// Closes a "holding" run via a brand-new market sell - the stop-loss/
// day-expiry/rule-exit/profit-target-fallback path. If a resting
// profit-target order exists, it must be cancelled first: this is the
// cancel-vs-fill race the design brief calls out explicitly. cancelOrder
// and the limit-order worker's own fill claim lock the exact same order
// row (see lib/db/orders.ts), so whichever gets there first wins - if the
// cancellation reports `already_filled`, the profit target was actually
// hit a moment ago, and that must be recorded as closed_target, not
// whatever exitReason this cycle was about to close it for.
async function closeHoldingBotRunViaMarketSell(
  run: BotRunRow,
  targetOrder: { id: string } | null,
  exitReason: BotRunExitReason,
  quote: Quote,
  now: Date,
): Promise<ExitBotRunOutcome> {
  if (run.entryTotalCents === null || run.entryQuantity === null) {
    throw new Error(`Bot run ${run.id} is "holding" but missing its entry fields`);
  }

  if (targetOrder) {
    const cancelResult = await cancelOrderByAccountId(run.accountId, targetOrder.id);

    if (!cancelResult.ok && cancelResult.reason === "already_filled") {
      const [filled] = await db
        .select({ filledPriceCents: orders.filledPriceCents, quantity: orders.quantity })
        .from(orders)
        .where(eq(orders.id, targetOrder.id));

      if (!filled || filled.filledPriceCents === null) {
        throw new Error(`Target order ${targetOrder.id} reported already_filled with no fill data`);
      }

      const exitTotalCents = filled.filledPriceCents * BigInt(filled.quantity);
      // closeAlreadyFilledBotRun's own WHERE (status = 'holding') makes its
      // write a harmless no-op if a second concurrent caller reaches this
      // exact branch for the same run at once (e.g. a cancellation racing
      // the monitoring cycle, both discovering the same already-filled
      // target order) - either way, the figures below are computed purely
      // from the filled order's own row, so they're correct regardless of
      // which caller's write actually won.
      await closeAlreadyFilledBotRun(run.id, run.entryTotalCents, exitTotalCents, now);
      return {
        outcome: "already_resolved",
        finalStatus: "closed_target",
        realizedPnlCents: computeBotRunRealizedPnl(run.entryTotalCents, exitTotalCents),
      };
    }
    // ok: true (cancelled), or not_cancellable/not_found (already resolved
    // some other way) - either way, proceed to the market sell below.
  }

  return tryExitBotRunViaMarketSell(run.id, quote, exitReason, now);
}

async function tryExitBotRunViaMarketSell(
  runId: string,
  quote: Quote,
  exitReason: BotRunExitReason,
  now: Date,
): Promise<ExitBotRunOutcome> {
  return db.transaction(async (tx) => {
    const [lockedRun] = await tx.select().from(botRuns).where(eq(botRuns.id, runId)).for("update");

    if (!lockedRun) {
      throw new Error(`Bot run ${runId} disappeared mid-transaction - this should be impossible`);
    }

    if (
      lockedRun.status !== "holding" ||
      lockedRun.entryQuantity === null ||
      lockedRun.entryTotalCents === null
    ) {
      return {
        outcome: "already_resolved",
        finalStatus: lockedRun.status,
        realizedPnlCents: lockedRun.realizedPnlCents,
      };
    }

    const [lockedAccount] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, lockedRun.accountId))
      .for("update");

    if (!lockedAccount) {
      throw new Error(`Account ${lockedRun.accountId} not found`);
    }

    const accountState = await loadAccountState(tx, lockedAccount.id);
    const result = executeMarketOrder(accountState, quote, "sell", lockedRun.entryQuantity, now);

    if (!result.ok) {
      await tx.insert(orders).values({
        accountId: lockedAccount.id,
        symbol: quote.symbol,
        side: "sell",
        type: "market",
        quantity: lockedRun.entryQuantity,
        status: "rejected",
        rejectReason: result.reason,
        botRunId: runId,
      });
      return { outcome: "rejected", reason: result.reason };
    }

    const { fill } = result;

    const [insertedOrder] = await tx
      .insert(orders)
      .values({
        accountId: lockedAccount.id,
        symbol: quote.symbol,
        side: "sell",
        type: "market",
        quantity: lockedRun.entryQuantity,
        status: "filled",
        filledPriceCents: fill.priceCents,
        filledAt: now,
        botRunId: runId,
      })
      .returning({ id: orders.id });

    if (!insertedOrder) {
      throw new Error("Failed to insert bot exit order");
    }

    await applyFillEffects(tx, lockedAccount.id, quote.symbol, fill);
    await recordFillTransaction(tx, lockedAccount.id, insertedOrder.id, "sell", fill);

    const realizedPnlCents = computeBotRunRealizedPnl(lockedRun.entryTotalCents, fill.totalCents);
    await tx
      .update(botRuns)
      .set({ status: exitReason, realizedPnlCents, closedAt: now })
      .where(eq(botRuns.id, runId));

    return { outcome: "closed", realizedPnlCents };
  });
}

export type CancelBotRunReason =
  // No run with this id exists for this account - either it was never
  // this account's run, or the id is simply wrong. Deliberately the same
  // reason for "doesn't exist" and "belongs to someone else" - same
  // information-leak reasoning as cancelOrderByAccountId's own "not_found".
  | "not_found"
  // Was "selecting" when this cancellation started, but the worker's own
  // selection cycle won the race and entered it first - a real, expected
  // outcome under concurrent access, not an error. There is now an open
  // position under this run; cancelling it requires a fresh attempt, which
  // will take the "holding" path instead.
  | "already_entered"
  // Was "holding," but resolved to a real closed_* status (by the
  // monitoring cycle, the resting limit order's own fill, or an earlier
  // cancellation call) before this attempt's own lock could win the race.
  | "already_closed"
  // Any other already-terminal state this run was in before this
  // cancellation attempt even started (already "cancelled," or resolved as
  // "failed_no_affordable_candidate") - nothing left to cancel, and no
  // exit ever happened, so this isn't "already_closed" either.
  | "already_resolved"
  // The "holding" path's own market sell was rejected outright - reuses
  // RejectReason rather than inventing a parallel set of reasons, same as
  // every other execution path in this app.
  | RejectReason;

export type CancelBotRunResult =
  | { ok: true; status: "cancelled" }
  | { ok: true; status: "closed_cancelled"; realizedPnlCents: Cents }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_entered" }
  | {
      ok: false;
      reason: "already_closed";
      actualStatus: BotRunRow["status"];
      realizedPnlCents: Cents | null;
    }
  | { ok: false; reason: "already_resolved"; actualStatus: BotRunRow["status"] }
  | { ok: false; reason: RejectReason };

// Reports an honest outcome for a run already found in some terminal state
// that isn't itself the direct result of THIS cancellation attempt -
// shared by both the "selecting" and "holding" paths below, since both can
// discover this same shape of situation (a race already lost, or a plain
// repeat call). Exhaustive over every status this function's caller can
// legitimately hand it - "selecting"/"holding" are deliberately NOT covered
// here (a live run is never "already resolved"; it goes through its own
// dedicated cancellation path instead), so passing either throws rather
// than silently mis-reporting.
function resolvedOutcomeForStatus(
  status: BotRunRow["status"],
  realizedPnlCents: Cents | null,
): CancelBotRunResult {
  switch (status) {
    case "closed_stop_loss":
    case "closed_target":
    case "closed_day_expiry":
    case "closed_rule_exit":
    case "closed_cancelled":
      return { ok: false, reason: "already_closed", actualStatus: status, realizedPnlCents };
    case "cancelled":
    case "failed_no_affordable_candidate":
      return { ok: false, reason: "already_resolved", actualStatus: status };
    case "selecting":
    case "holding":
      throw new Error(
        `resolvedOutcomeForStatus called with a live status ("${status}") - this should be impossible`,
      );
  }
}

// Claims one "selecting" run (same lock-then-re-check primitive as
// tryEnterBotRun) and flips it straight to "cancelled" if it's still
// selecting - no position exists yet, so there's no order to place and no
// money to move. If the selection worker won the race and already entered
// this run, that's reported as "already_entered," not silently swallowed
// and not an error either - the exact same discriminated-outcome
// discipline as cancelOrderByAccountId's own "already_filled".
async function cancelSelectingBotRun(runId: string, now: Date): Promise<CancelBotRunResult> {
  return db.transaction(async (tx) => {
    const [lockedRun] = await tx.select().from(botRuns).where(eq(botRuns.id, runId)).for("update");

    if (!lockedRun) {
      throw new Error(`Bot run ${runId} disappeared mid-cancellation - this should be impossible`);
    }

    if (lockedRun.status !== "selecting") {
      if (lockedRun.status === "holding") {
        return { ok: false, reason: "already_entered" };
      }
      return resolvedOutcomeForStatus(lockedRun.status, lockedRun.realizedPnlCents);
    }

    await tx
      .update(botRuns)
      .set({ status: "cancelled", closedAt: now })
      .where(eq(botRuns.id, runId));

    return { ok: true, status: "cancelled" };
  });
}

// Closes a "holding" run's real position via the exact same machinery the
// monitoring cycle's own stop-loss/target/day-expiry/rule-exit paths use
// (closeHoldingBotRunViaMarketSell -> tryExitBotRunViaMarketSell) - no new
// order logic, no new money math, just a new BotRunExitReason
// ("closed_cancelled"). A fresh quote is fetched here, outside any
// transaction (never hold a DB transaction open across a network call,
// same discipline placeMarketOrder already follows) and never cached, per
// CLAUDE.md's live-quote rule.
async function cancelHoldingBotRun(
  run: BotRunRow,
  selectedSymbol: string,
  now: Date,
): Promise<CancelBotRunResult> {
  let quote: Quote;
  try {
    quote = await fetchQuote(selectedSymbol);
  } catch (error) {
    if (!(error instanceof NoTwoSidedQuoteError)) {
      throw error;
    }
    // No active two-sided market for this symbol right now (most often the
    // market being closed) - a real, expected condition, not an error. The
    // position is untouched; a later attempt can retry once a quote exists.
    return { ok: false, reason: "no_quote" };
  }

  // Same query monitorOneBotRun already uses to find the resting
  // profit-target sell, if one exists - at most one per run, ever (see
  // placeRestingProfitTarget).
  const [targetOrder] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.botRunId, run.id), eq(orders.side, "sell"), eq(orders.type, "limit")))
    .limit(1);

  const outcome = await closeHoldingBotRunViaMarketSell(
    run,
    targetOrder ?? null,
    "closed_cancelled",
    quote,
    now,
  );

  switch (outcome.outcome) {
    case "closed":
      return { ok: true, status: "closed_cancelled", realizedPnlCents: outcome.realizedPnlCents };
    case "already_resolved":
      return resolvedOutcomeForStatus(outcome.finalStatus, outcome.realizedPnlCents);
    case "rejected":
      return { ok: false, reason: outcome.reason };
  }
}

// The human-facing entry point (Route Handlers resolve a session to a
// userId, never an accountId directly) - same shape as createBotRun's own
// userId-in convention in this same file. Routes to whichever of the two
// cancellation paths above actually applies, based on a first, unlocked
// read (this run either belongs to this account or it doesn't, and that
// fact can't change) - the authoritative status re-check that decides the
// real outcome always happens under a row lock inside whichever path is
// taken, never here.
export async function cancelBotRun(
  userId: string,
  runId: string,
  now: Date,
): Promise<CancelBotRunResult> {
  const account = await getOrCreateAccount(userId);

  const [run] = await db
    .select()
    .from(botRuns)
    .where(and(eq(botRuns.id, runId), eq(botRuns.accountId, account.id)));

  if (!run) {
    return { ok: false, reason: "not_found" };
  }

  if (run.status === "selecting") {
    return cancelSelectingBotRun(runId, now);
  }

  if (run.status === "holding") {
    if (run.selectedSymbol === null) {
      throw new Error(`Bot run ${runId} is "holding" but missing its selected symbol`);
    }
    return cancelHoldingBotRun(run, run.selectedSymbol, now);
  }

  return resolvedOutcomeForStatus(run.status, run.realizedPnlCents);
}
