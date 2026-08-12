import { DEFAULT_RSI_PERIOD } from "./indicators";
import type { Cents } from "./money";

// Exactly one rule, not a blend - see the bot design proposal in
// conversation for why this specific pair was chosen (a pullback within an
// uptrend, not a falling knife) and what its expected edge honestly is.
// The id is part of the contract every bot run stores alongside its own
// params (lib/db/schema.ts's bot_runs.ruleId/ruleParams) - a future v2 of
// this rule must ship under a new id, never by silently changing what this
// one means, or past runs' measured results would be reinterpreted under a
// definition they were never actually run against.
export const RSI_PULLBACK_UPTREND_V1_ID = "rsi_pullback_uptrend_v1";

export type BotRuleParams = {
  rsiPeriod: number;
  rsiEntryThreshold: number;
  rsiExitThreshold: number;
  smaPeriod: number;
};

export const RSI_PULLBACK_UPTREND_V1_PARAMS: BotRuleParams = {
  rsiPeriod: DEFAULT_RSI_PERIOD,
  rsiEntryThreshold: 30,
  rsiExitThreshold: 50,
  smaPeriod: 50,
};

// Already-computed indicator values for one symbol at one point in time -
// not a price series. Computing RSI/SMA from a raw closes array is a
// separate, also-pure step (see lib/db/bot-runs.ts, which has to fetch bars
// before it has a series to compute from - fetching isn't allowed in this
// file per CLAUDE.md). Keeping this function's input this small is what
// makes it testable with fixed fixtures, the same discipline
// shouldFillLimitOrder (lib/trading/limit-fill.ts) already established.
//
// `price` is the latest CLOSE the indicators were computed from, not a live
// bid/ask - this rule is evaluated once per signal (the same daily-close
// series RSI/SMA are computed from), and the actual entry/exit order still
// fills at the live ask/bid via the normal execution path regardless of
// what price this decision was made against.
export type RuleSignals = {
  rsi: number;
  price: Cents;
  sma: number;
};

// Buy the pullback, not the knife: RSI oversold on its own says nothing
// about direction context, and would happily buy a stock in a genuine
// downtrend the moment it looks "cheap enough". Requiring price above
// SMA(50) restricts entries to a pullback inside a longer uptrend - it
// doesn't guarantee the trend continues (nothing can), but it's a real,
// stated filter, not a judgment call layered on top of the RSI reading.
export function ruleShouldEnter(signals: RuleSignals, params: BotRuleParams): boolean {
  return signals.rsi < params.rsiEntryThreshold && Number(signals.price) > signals.sma;
}

// The rule's own reversal signal: RSI recovering back above the exit
// threshold means the oversold condition that justified the entry no
// longer holds. Deliberately just this one condition - profit target,
// stop-loss, and day-order expiry are cross-cutting bot-run concerns that
// apply regardless of which rule is active (see lib/trading/bot-targets.ts
// and lib/trading/bot-day-expiry.ts), not part of a swappable rule's own
// definition. Takes only the RSI value, not full RuleSignals - unlike
// entry, exit genuinely doesn't need price/SMA, and a narrower input type
// is what makes that fact visible at every call site instead of relying on
// callers to know which fields this particular check happens to ignore.
export function ruleShouldExit(signals: { rsi: number }, params: BotRuleParams): boolean {
  return signals.rsi > params.rsiExitThreshold;
}
