import { z } from "zod";
import { DEFAULT_RSI_PERIOD } from "./indicators";
import type { Cents } from "./money";

// Exactly one rule per run, not a blend - see the bot design proposal in
// conversation for why this specific pair was chosen (a pullback within an
// uptrend, not a falling knife) and what its expected edge honestly is.
// The id is part of the contract every bot run stores alongside its own
// params (lib/db/schema.ts's bot_runs.ruleId/ruleParams) - a future v2 of
// this rule must ship under a new id, never by silently changing what this
// one means, or past runs' measured results would be reinterpreted under a
// definition they were never actually run against.
export const RSI_PULLBACK_UPTREND_V1_ID = "rsi_pullback_uptrend_v1";

// Each rule family has its own params shape - `kind` is what lets a single
// stored bot_runs.ruleParams JSON blob be parsed back into the right shape
// (see parseRuleParams below) and lets ruleShouldEnter/ruleShouldExit
// dispatch to the right formula, instead of one function silently assuming
// every rule looks like RSI-pullback's own {rsi, price, sma} shape - which
// is exactly what shipping a second, genuinely different rule family
// (breakout/golden-cross) would otherwise make dangerous rather than merely
// awkward.
export type RsiPullbackParams = {
  kind: "rsi_pullback";
  rsiPeriod: number;
  rsiEntryThreshold: number;
  rsiExitThreshold: number;
  smaPeriod: number;
};

export const RSI_PULLBACK_UPTREND_V1_PARAMS: RsiPullbackParams = {
  kind: "rsi_pullback",
  rsiPeriod: DEFAULT_RSI_PERIOD,
  rsiEntryThreshold: 30,
  rsiExitThreshold: 50,
  smaPeriod: 50,
};

// v2: entry threshold raised from 30 to 40, everything else unchanged from
// v1 - the decision made after a real historical scan (see STATE.md for
// the full four-variant comparison and reasoning). SMA(50) - the "is this
// genuinely an uptrend" half of the rule - is deliberately left alone;
// only the "how oversold" bar moved, so this still buys pullbacks within a
// real medium-term uptrend, not a looser trend definition. Shipped as a
// new id, not an edit to v1's own params, for the exact reason v1's own
// comment above states: bot_runs rows already recorded under v1 must keep
// meaning what they meant when they were run, not be silently
// reinterpreted by a later parameter change.
//
// Stays same-day-only (see maxHoldDays below) even though a real
// historical scan of its own natural hold-to-exit time shows a 14-day
// median, not same-day (50-day p90, 217 real episodes, ~5yr/517-symbol
// backtest) - deliberately: this is the one strategy meant to be measured
// as pure intraday mean-reversion, a design choice for comparison against
// the other two's multi-day holds, not a claim that same-day matches its
// own natural resolution time. If that reasoning ever stops applying,
// revisit with the real number above, not by assuming same-day was always
// backtested-accurate for this rule either.
export const RSI_PULLBACK_UPTREND_V2_ID = "rsi_pullback_uptrend_v2";

export const RSI_PULLBACK_UPTREND_V2_PARAMS: RsiPullbackParams = {
  kind: "rsi_pullback",
  rsiPeriod: DEFAULT_RSI_PERIOD,
  rsiEntryThreshold: 40,
  rsiExitThreshold: 50,
  smaPeriod: 50,
};

// Golden cross: a trend-STRUCTURE rule, genuinely different philosophy from
// RSI-pullback's mean-reversion - buys the day the medium-term trend
// (SMA(20)) turns up through the longer-term trend (SMA(50)), not a
// pullback within an already-established one. Deliberately just the two
// periods - no RSI, no volume filter beyond what rankEligibleBotCandidates
// already applies to every rule uniformly.
export type GoldenCrossParams = {
  kind: "golden_cross";
  fastPeriod: number;
  slowPeriod: number;
};

export const GOLDEN_CROSS_V1_ID = "golden_cross_v1";

export const GOLDEN_CROSS_V1_PARAMS: GoldenCrossParams = {
  kind: "golden_cross",
  fastPeriod: 20,
  slowPeriod: 50,
};

// Capped at a hard 30-day max hold (see maxHoldDays below) - a real
// historical scan (~5yr/517-symbol backtest, 6,388 real episodes) found a
// 55-day median natural hold-to-exit time, 140-day p90, 462-day max: this
// cap BINDS on 77.8% of episodes, meaning the cap - not the rule's own
// reversal signal - is what closes most runs in practice, not a rare
// backstop. Accepted deliberately, not an oversight: the same trade-off is
// documented on BREAKOUT_52WK_HIGH_V1_PARAMS below, where it binds far more
// often still (98.7%) - see that comment for the full reasoning, which
// applies here too.

// Breakout's params shape. `breakoutWindowDays` is also the period of the
// "is the trend rising" SMA check (see ruleShouldEnter below) - one window
// governs both "is this a new high" and "is the medium-term trend still
// climbing," not two independently-chosen numbers.
export type BreakoutParams = {
  kind: "breakout";
  breakoutWindowDays: number;
  risingLookbackDays: number;
  // The exit condition's own SMA period ("price falls back below SMA(N)")
  // - kept as its own field, not assumed to equal breakoutWindowDays, since
  // the entry window and the exit trend-filter are conceptually different
  // knobs even though this app's own v1 proposal happens to want them equal.
  exitSmaPeriod: number;
};

// The id names what it actually checks (a 52-week/365-trading-day high),
// not "v1" of some fixed, generic "breakout" concept - deliberately, because
// this window is not a tightened version of a shorter one, it's a
// genuinely different signal (see the rejected-20-day note below), and this
// project's ids are permanent once real runs are tagged with them (see
// RSI_PULLBACK_UPTREND_V1_ID's own header comment above for the same
// reasoning). A future, genuinely different breakout window - a 90-day
// "recent momentum" breakout, say - ships under its own new id, not a
// renamed or renumbered version of this one.
//
// **The originally proposed window (20-day high, SMA(20) rising vs. 5 days
// ago) was rejected outright, not tightened from here** - a real 1000-day/
// 517-symbol historical scan found it fired 21,846 times across 514 of 517
// symbols, functionally "always eligible" on almost any uptrend rather than
// a selective signal. Retightening was tried first along the originally
// suggested levers (10-day and 20-day rising-lookback, a 50-day instead of
// 20-day high) - even the strictest of those combinations (50-day high +
// rising-20d) still produced 12,862 episodes, nowhere near a selective
// signal. What actually worked required extending well past the
// originally suggested range: a 365-trading-day (52-week) high, still with
// a 20-day rising-SMA lookback, lands at 3,547 episodes across 364/517
// symbols - close to golden_cross_v1's own 3,541. **A future session should
// not read this as "365 was chosen from a menu that included 20" and
// casually shrink it back toward 20 or 50 days assuming that's just a
// looser, equally-valid variant** - 20 days was the original, rejected
// starting point, not a nearby alternative; the whole point of this id
// naming a 52-week high specifically is that a materially shorter window
// is a different, already-tried-and-rejected signal, not this one tuned.
export const BREAKOUT_52WK_HIGH_V1_ID = "breakout_52wk_high_v1";

export const BREAKOUT_52WK_HIGH_V1_PARAMS: BreakoutParams = {
  kind: "breakout",
  breakoutWindowDays: 365,
  risingLookbackDays: 20,
  exitSmaPeriod: 365,
};

// Capped at a hard 30-day max hold (see maxHoldDays below), and this
// number deserves the same plain-numbers treatment the id's own rejected-
// 20-day note above gets - it is not a rare backstop for this rule. A real
// historical scan (~5yr/517-symbol backtest, 7,531 real episodes) found a
// 260-day median natural hold-to-exit time, a 608-day p90, and a 1,150-day
// max: the 30-day cap BINDS on 98.7% of episodes. In plain terms, this
// redefines breakout_52wk_high_v1 in practice from "ride a real trend
// until it reverses" (what the rule's own SMA(365) exit condition is
// actually designed to do) to "hold roughly 30 days, then force-exit
// regardless of the trend" - the cap, not the rule's own signal, is what
// closes nearly every run. **This is a known, accepted trade-off, decided
// deliberately with this exact number in front of the decision-maker, not
// an oversight discovered later.** A future session revisiting the 30-day
// figure should re-run this same scan rather than assume the original
// number still reflects current market behavior, but should not read this
// comment as inviting a "the cap barely matters" assumption either way -
// it very much does.
export type BotRuleParams = RsiPullbackParams | GoldenCrossParams | BreakoutParams;

// The one registry every caller needing to know "which rules can a human
// actually choose right now" reads - createBotRun's own validation and
// BotRunForm's strategy selector both import this directly (it's plain
// data, safe in a Client Component, no duplication needed). v1 is
// deliberately NOT listed - it stays fully defined and valid for any run
// already recorded under it, but was superseded by v2 and was never meant
// to be choosable again for a new run.
export const AVAILABLE_STRATEGIES: Record<
  string,
  { params: BotRuleParams; label: string; description: string }
> = {
  [RSI_PULLBACK_UPTREND_V2_ID]: {
    params: RSI_PULLBACK_UPTREND_V2_PARAMS,
    label: "RSI Pullback",
    description:
      "Mean-reversion: buys an oversold pullback (RSI(14)<40) within an uptrend (close>SMA(50)).",
  },
  [GOLDEN_CROSS_V1_ID]: {
    params: GOLDEN_CROSS_V1_PARAMS,
    label: "Golden Cross",
    description: "Trend structure: buys the day SMA(20) crosses above SMA(50).",
  },
  [BREAKOUT_52WK_HIGH_V1_ID]: {
    params: BREAKOUT_52WK_HIGH_V1_PARAMS,
    label: "52-Week High Breakout",
    description: "Momentum: buys a new 365-day high with a rising SMA(365) over the last 20 days.",
  },
};

// How long a "holding" run under this rule family may be held before being
// force-exited regardless of any other condition - null means no cap
// beyond the existing same-day day-order-expiry check
// (lib/trading/bot-day-expiry.ts). A property of the RULE FAMILY (dispatch
// on `kind`), not a stored ruleParams field: every version of a family is
// meant to share the same holding-period philosophy even as its own
// numeric thresholds change across versions (v1 vs v2's own entry
// threshold, say), and keeping it out of the stored JSON avoids a legacy-
// row backward-compat question for every already-recorded run the way a
// new required field would (the same reasoning inferLegacyKind already
// exists to solve for `kind` itself). See RSI_PULLBACK_UPTREND_V2_PARAMS,
// GOLDEN_CROSS_V1_PARAMS, and BREAKOUT_52WK_HIGH_V1_PARAMS's own comments
// above for the real historical numbers this was decided against - both
// non-null values were chosen with the real, honest knowledge that the cap
// itself would bind far more often than the rule's own reversal signal,
// not despite it.
export function maxHoldDays(kind: BotRuleParams["kind"]): number | null {
  switch (kind) {
    case "rsi_pullback":
      return null;
    case "golden_cross":
      return 30;
    case "breakout":
      return 30;
  }
}

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
//
// Bundled with its own matching `params` (not passed as a sibling argument)
// so the type system - not just convention - prevents evaluating one rule
// family's signals against a different family's params. `kind` is the
// top-level discriminant TypeScript narrows on; nesting it one level
// deeper (e.g. only on `params.kind`) doesn't reliably narrow the whole
// union the same way.
export type RuleEvaluation =
  | {
      kind: "rsi_pullback";
      params: RsiPullbackParams;
      signals: { rsi: number; price: Cents; sma: number };
    }
  | {
      kind: "golden_cross";
      params: GoldenCrossParams;
      signals: {
        smaFast: number;
        smaFastYesterday: number;
        smaSlow: number;
        smaSlowYesterday: number;
      };
    }
  | {
      kind: "breakout";
      params: BreakoutParams;
      signals: { price: Cents; priorHigh: number; smaToday: number; smaLagged: number };
    };

// Buy the pullback, not the knife: RSI oversold on its own says nothing
// about direction context, and would happily buy a stock in a genuine
// downtrend the moment it looks "cheap enough". Requiring price above
// SMA(50) restricts entries to a pullback inside a longer uptrend - it
// doesn't guarantee the trend continues (nothing can), but it's a real,
// stated filter, not a judgment call layered on top of the RSI reading.
//
// golden_cross: an EVENT, not a state - yesterday's fast SMA must have
// been at or below the slow SMA, and today's must be above. A bot run
// started on day 47 of an already-established uptrend (fast already well
// above slow, no fresh cross today) must not treat "the trend is still up"
// the same as "the trend just turned up" - the whole point of a
// crossover rule is the crossing, not the resulting state, which can stay
// true for months after the moment that actually justified buying has
// passed. Correctly gated using only this single day's signals (today's
// and yesterday's SMA values), not any external memory of prior
// evaluations - a plain, stateless function stays true to the same "one
// pure rule, no hidden state" discipline every rule here already follows.
//
// breakout: deliberately NOT event-gated the same way, despite a stock
// being able to sit at/near its own rolling high for many consecutive
// days. Unlike golden_cross's crossing check, the rolling-high comparison
// re-validates itself fresh every day against an adaptively ratcheting
// threshold (rollingHigh includes yesterday's new high once it happens,
// so today needs a genuinely NEW high over that already-updated bar, not
// a stale leftover from days ago) - a run started on day 5 of an ongoing
// breakout, where day 5 itself is still a real new high over the trailing
// window, is buying a fresh signal, not an old one. A single bot_run can
// in any case only ever act on the one day it's actually evaluated on
// (selecting -> holding is a one-way, one-shot transition), so there's no
// re-entry risk from a single run re-firing regardless.
export function ruleShouldEnter(evaluation: RuleEvaluation): boolean {
  switch (evaluation.kind) {
    case "rsi_pullback": {
      const { params, signals } = evaluation;
      return signals.rsi < params.rsiEntryThreshold && Number(signals.price) > signals.sma;
    }
    case "golden_cross": {
      const { signals } = evaluation;
      return (
        signals.smaFastYesterday <= signals.smaSlowYesterday && signals.smaFast > signals.smaSlow
      );
    }
    case "breakout": {
      const { signals } = evaluation;
      return Number(signals.price) > signals.priorHigh && signals.smaToday > signals.smaLagged;
    }
  }
}

// The rule's own reversal signal - cross-cutting profit target/stop-loss/
// day-order expiry apply regardless of which rule is active (see
// lib/trading/bot-targets.ts and lib/trading/bot-day-expiry.ts), so this is
// only each rule's OWN "the setup that justified entry no longer holds"
// check. No event-gating needed here for any rule, unlike entry: exit only
// ever gets evaluated while a run is already "holding" a single position,
// so there's no equivalent "a new run started mid-state" risk - once a run
// exits, it's closed, never re-evaluated again, so a plain state check
// (is the condition currently true) is correct as-is.
export type RuleExitEvaluation =
  | { kind: "rsi_pullback"; params: RsiPullbackParams; signals: { rsi: number } }
  | { kind: "golden_cross"; signals: { smaFast: number; smaSlow: number } }
  | { kind: "breakout"; signals: { price: Cents; sma: number } };

export function ruleShouldExit(evaluation: RuleExitEvaluation): boolean {
  switch (evaluation.kind) {
    case "rsi_pullback":
      return evaluation.signals.rsi > evaluation.params.rsiExitThreshold;
    case "golden_cross":
      return evaluation.signals.smaFast < evaluation.signals.smaSlow;
    case "breakout":
      return Number(evaluation.signals.price) < evaluation.signals.sma;
  }
}

const RsiPullbackParamsSchema = z.object({
  kind: z.literal("rsi_pullback"),
  rsiPeriod: z.number(),
  rsiEntryThreshold: z.number(),
  rsiExitThreshold: z.number(),
  smaPeriod: z.number(),
});

const GoldenCrossParamsSchema = z.object({
  kind: z.literal("golden_cross"),
  fastPeriod: z.number(),
  slowPeriod: z.number(),
});

const BreakoutParamsSchema = z.object({
  kind: z.literal("breakout"),
  breakoutWindowDays: z.number(),
  risingLookbackDays: z.number(),
  exitSmaPeriod: z.number(),
});

const BotRuleParamsSchema = z.discriminatedUnion("kind", [
  RsiPullbackParamsSchema,
  GoldenCrossParamsSchema,
  BreakoutParamsSchema,
]);

// Every bot_runs row created before this file had a `kind` field at all
// (every run in the real database as of this change) stored ruleParams as
// a bare {rsiPeriod, rsiEntryThreshold, rsiExitThreshold, smaPeriod} object
// - only rsi_pullback ever existed then, so `kind` is unambiguously
// inferable rather than needing a real data migration to backfill it onto
// already-recorded production rows. New rows always write `kind` explicitly
// (see AVAILABLE_STRATEGIES) - this inference only ever matches a row that
// predates multi-strategy support existing at all.
function inferLegacyKind(raw: unknown): unknown {
  if (raw !== null && typeof raw === "object" && !("kind" in raw) && "rsiEntryThreshold" in raw) {
    return { ...raw, kind: "rsi_pullback" };
  }
  return raw;
}

// Parses a bot_runs row's own stored ruleParams back into a typed
// BotRuleParams - used at evaluation time (selection/monitoring), not at
// creation time (which writes an already-known-good AVAILABLE_STRATEGIES
// value directly). Deliberately re-validates rather than trusting a bare
// cast: this is read-back JSON that could in principle have been written
// by a different, older, or buggy version of this code, the same
// "validate at the boundary" discipline CLAUDE.md requires of a real
// external API response - a stored row is exactly analogous, just
// internal rather than a network boundary. Returns null (never throws) on
// anything unparseable, so a caller can treat an unrecognized/corrupt
// ruleParams the same deliberate way it already treats an unrecognized
// ruleId - a run that quietly never matches any candidate, not a crash
// that takes down an entire worker cycle over one bad row.
export function parseRuleParams(raw: unknown): BotRuleParams | null {
  const result = BotRuleParamsSchema.safeParse(inferLegacyKind(raw));
  return result.success ? result.data : null;
}

// A generic, per-FAMILY label - independent of AVAILABLE_STRATEGIES' own
// labels, which name a specific, currently-choosable VERSION ("RSI
// Pullback" is v2's own label). Exists so a run recorded under a
// superseded id (v1, still valid to look at - see
// RSI_PULLBACK_UPTREND_V1_ID's own header comment - just no longer
// registered) still gets a real, readable label from describeBotRuleLabel
// below, instead of falling all the way back to a raw ruleId string.
function describeRuleKindLabel(kind: BotRuleParams["kind"]): string {
  switch (kind) {
    case "rsi_pullback":
      return "RSI Pullback";
    case "golden_cross":
      return "Golden Cross";
    case "breakout":
      // Matches AVAILABLE_STRATEGIES' own registered label for
      // breakout_52wk_high_v1 exactly - this fallback only ever fires for
      // an unregistered id, but keeping the wording identical means a
      // future superseded breakout id reads the same as the current one,
      // the same consistency rsi_pullback's v1-vs-v2 fallback already has.
      return "52-Week High Breakout";
  }
}

// The human-readable strategy label for one bot run - prefers
// AVAILABLE_STRATEGIES' own curated label when ruleId is still a live,
// choosable strategy (every current run), falling back to a generic
// per-family label (describeRuleKindLabel above) derived from the run's
// own stored ruleParams for a superseded id that predates this round's
// registry. Falls back to the raw ruleId itself only if ruleParams can't
// be parsed at all - the same "never crash on a bad row, show something
// honest instead" discipline parseRuleParams already established.
export function describeBotRuleLabel(ruleId: string, ruleParams: unknown): string {
  const registered = AVAILABLE_STRATEGIES[ruleId];
  if (registered) {
    return registered.label;
  }

  const parsed = parseRuleParams(ruleParams);
  return parsed ? describeRuleKindLabel(parsed.kind) : ruleId;
}

// A compact, per-run summary of a rule's own numeric params - "RSI<40,
// SMA(50)" - distinct from AVAILABLE_STRATEGIES' own `description` (a full
// sentence meant for the strategy PICKER, not a per-run subtitle). Useful
// anywhere multiple runs or rule variants sit in one list and need to be
// told apart at a glance (BotRunsPanel, BotStatsPanel) - and once a future
// version bump (a v3, say) ships alongside v2 in the same list, this is
// what distinguishes them without needing its own bespoke wording added at
// that point. Returns null (never throws) when ruleParams can't be parsed,
// same discipline as parseRuleParams/describeBotRuleLabel above.
export function describeBotRuleParams(ruleParams: unknown): string | null {
  const parsed = parseRuleParams(ruleParams);
  if (!parsed) return null;

  switch (parsed.kind) {
    case "rsi_pullback":
      return `RSI<${parsed.rsiEntryThreshold}, SMA(${parsed.smaPeriod})`;
    case "golden_cross":
      return `SMA(${parsed.fastPeriod})×SMA(${parsed.slowPeriod})`;
    case "breakout":
      return `${parsed.breakoutWindowDays}d high, SMA rising ${parsed.risingLookbackDays}d`;
  }
}
