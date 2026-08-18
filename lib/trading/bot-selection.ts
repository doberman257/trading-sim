import { type BotRuleParams, type RuleEvaluation, ruleShouldEnter } from "./bot-rule";
import type { Cents } from "./money";
import { isSpreadImplausiblyWide } from "./quote";

// One symbol's current signals, from the curated watchlist scan
// (lib/db/bot-runs.ts fetches bars+quotes and builds these). Every rule
// family's own signals are computed unconditionally, up front, for every
// candidate - not lazily per rule-in-use - deliberately: with only three
// rule families total, computing a few extra sma/rollingHigh values per
// symbol from data already fetched is cheap, and it keeps this shape a
// plain data bag instead of a pluggable-strategy abstraction that would
// only earn its cost once a fourth, genuinely different rule shape shows
// up (see AVAILABLE_STRATEGIES in bot-rule.ts for the same reasoning
// stated at the registry level).
export type BotCandidate = {
  symbol: string;
  bidCents: Cents;
  askCents: Cents;
  // The latest daily bar's volume - the tiebreaker signal, not a separate
  // fetch (already comes back from the same bars request used for every
  // rule's own indicators).
  volume: number;
  price: Cents;
  // Each rule family's own signal group is independently nullable - null
  // means "not enough bar history yet for THIS family's own indicators"
  // (e.g. golden_cross's SMA(50)-yesterday needs one more day of history
  // than rsi_pullback's SMA(50)-today does). A symbol missing one family's
  // signals can still be a perfectly good candidate under a DIFFERENT
  // family's rule - gating the whole candidate on every family having full
  // data, regardless of which rule a given run actually uses, would wrongly
  // drop real candidates for reasons that have nothing to do with the rule
  // actually being evaluated.
  rsiPullback: { rsi: number; sma: number } | null;
  goldenCross: {
    smaFast: number;
    smaFastYesterday: number;
    smaSlow: number;
    smaSlowYesterday: number;
  } | null;
  // priorHigh/smaToday/smaLagged only - `price` (breakout's own entry
  // signal compares against it) is already on the candidate above, same as
  // rsi_pullback reuses it rather than duplicating it into its own group.
  breakout: { priorHigh: number; smaToday: number; smaLagged: number } | null;
};

// Builds the one RuleEvaluation shape ruleShouldEnter actually needs for a
// given run's own params - the type system (RuleEvaluation's `kind`
// discriminant) is what makes it impossible to accidentally hand one rule's
// signals to a different rule's params, not just convention. Returns null
// when this candidate doesn't have the signal group this params.kind needs
// yet (see BotCandidate's own comment) - treated as "not eligible" by the
// caller, not an error: a genuinely common, expected case for a
// recently-added watchlist symbol.
function buildEvaluation(candidate: BotCandidate, params: BotRuleParams): RuleEvaluation | null {
  switch (params.kind) {
    case "rsi_pullback": {
      if (!candidate.rsiPullback) return null;
      const { rsi, sma } = candidate.rsiPullback;
      return { kind: "rsi_pullback", params, signals: { rsi, price: candidate.price, sma } };
    }
    case "golden_cross":
      if (!candidate.goldenCross) return null;
      return { kind: "golden_cross", params, signals: candidate.goldenCross };
    case "breakout": {
      if (!candidate.breakout) return null;
      const { priorHigh, smaToday, smaLagged } = candidate.breakout;
      return {
        kind: "breakout",
        params,
        signals: { price: candidate.price, priorHigh, smaToday, smaLagged },
      };
    }
  }
}

// Every candidate that both satisfies the entry rule AND has a currently
// plausible spread, ranked highest-volume first - never just the single
// "best" pick, because the caller (lib/db/bot-runs.ts) needs to keep
// falling back to the next-ranked candidate if the top one can't actually
// be sized within the run's capital (see lib/trading/bot-sizing.ts).
//
// The wide-spread filter reuses isSpreadImplausiblyWide (already built and
// empirically confirmed against real thin-liquidity data - see
// lib/trading/quote.ts) rather than a new heuristic: a candidate whose
// spread is implausibly wide right now is exactly the kind of illiquid name
// this filter already exists to flag, and there is no reason a bot buying
// unattended should tolerate a risk a human is warned about. Applied
// uniformly to every rule family, not just RSI-pullback - a thin, wide-
// spread name is exactly as bad a fill regardless of which signal flagged
// it as a candidate.
//
// The tiebreaker is highest volume, not "most oversold"/"strongest
// breakout"/etc (the more obvious choice per rule) - deliberately, per the
// design proposal: a thin name trades on light volume, which tends to
// produce MORE extreme swings in any of these indicators from a handful of
// trades, not a genuine signal. Ranking by volume pulls the opposite way,
// toward the candidate where the signal is least likely to be a liquidity
// artifact - a stated rule, not a judgment call, same as everything else
// this file decides, and the same reasoning applies regardless of which
// rule is doing the ranking.
export function rankEligibleBotCandidates(
  candidates: readonly BotCandidate[],
  params: BotRuleParams,
): BotCandidate[] {
  return candidates
    .filter((candidate) => {
      if (isSpreadImplausiblyWide(candidate.bidCents, candidate.askCents)) return false;
      const evaluation = buildEvaluation(candidate, params);
      return evaluation !== null && ruleShouldEnter(evaluation);
    })
    .toSorted((a, b) => b.volume - a.volume);
}
