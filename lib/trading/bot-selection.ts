import { type BotRuleParams, ruleShouldEnter } from "./bot-rule";
import type { Cents } from "./money";
import { isSpreadImplausiblyWide } from "./quote";

// One symbol's current signals, from the curated watchlist scan
// (lib/db/bot-runs.ts fetches bars+quotes and builds these). `rsi`/`sma`
// are computed from the same daily-close series - see bot-rule.ts's own
// note on why `price` there means "the latest close", not a live tick.
export type BotCandidate = {
  symbol: string;
  bidCents: Cents;
  askCents: Cents;
  // The latest daily bar's volume - the tiebreaker signal, not a separate
  // fetch (already comes back from the same bars request used for RSI/SMA).
  volume: number;
  rsi: number;
  price: Cents;
  sma: number;
};

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
// unattended should tolerate a risk a human is warned about.
//
// The tiebreaker is highest volume, not "most oversold" (the more obvious
// choice) - deliberately, per the design proposal: a thin name trades on
// light volume, which tends to produce MORE extreme RSI swings from a
// handful of trades, not a genuine signal. Ranking by "most oversold"
// would systematically favor exactly the illiquid names the spread filter
// above is trying to screen out. Ranking by volume pulls the opposite way,
// toward the candidate where the signal is least likely to be a liquidity
// artifact - a stated rule, not a judgment call, same as everything else
// this file decides.
export function rankEligibleBotCandidates(
  candidates: readonly BotCandidate[],
  params: BotRuleParams,
): BotCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        !isSpreadImplausiblyWide(candidate.bidCents, candidate.askCents) &&
        ruleShouldEnter({ rsi: candidate.rsi, price: candidate.price, sma: candidate.sma }, params),
    )
    .toSorted((a, b) => b.volume - a.volume);
}
