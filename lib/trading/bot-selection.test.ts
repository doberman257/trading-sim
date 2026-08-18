import { describe, expect, it } from "vitest";
import {
  BREAKOUT_52WK_HIGH_V1_PARAMS,
  GOLDEN_CROSS_V1_PARAMS,
  RSI_PULLBACK_UPTREND_V1_PARAMS,
} from "./bot-rule";
import { rankEligibleBotCandidates, type BotCandidate } from "./bot-selection";
import { toCents } from "./money";

const params = RSI_PULLBACK_UPTREND_V1_PARAMS;

function candidate(
  overrides: Partial<Omit<BotCandidate, "rsiPullback" | "goldenCross" | "breakout">> & {
    symbol: string;
    rsiPullback?: Partial<BotCandidate["rsiPullback"]>;
    goldenCross?: Partial<BotCandidate["goldenCross"]>;
    breakout?: Partial<BotCandidate["breakout"]>;
  },
): BotCandidate {
  const { rsiPullback, goldenCross, breakout, ...rest } = overrides;
  return {
    bidCents: toCents("99.50"),
    askCents: toCents("100.00"),
    volume: 1_000_000,
    price: toCents("105.00"),
    rsiPullback: { rsi: 25, sma: 10000, ...rsiPullback },
    // Deliberately not eligible under golden_cross by default (fast stayed
    // below slow both today and yesterday) - a candidate() call that only
    // cares about the rsi_pullback rule shouldn't accidentally also qualify
    // under golden_cross and mask a bug in a test that ranks by one rule.
    goldenCross: {
      smaFast: 90,
      smaFastYesterday: 89,
      smaSlow: 100,
      smaSlowYesterday: 100,
      ...goldenCross,
    },
    // Deliberately not eligible under breakout by default either (price
    // $105.00/10500 sits below priorHigh, and the SMA isn't rising) - same
    // reasoning as goldenCross above.
    breakout: { priorHigh: 20000, smaToday: 100, smaLagged: 200, ...breakout },
    ...rest,
  };
}

describe("rankEligibleBotCandidates - rsi_pullback", () => {
  it("excludes a candidate that does not satisfy the entry rule", () => {
    const result = rankEligibleBotCandidates(
      [candidate({ symbol: "AAA", rsiPullback: { rsi: 45 } })],
      params,
    );
    expect(result).toEqual([]);
  });

  it("excludes a candidate whose current spread is implausibly wide, even though it satisfies the entry rule", () => {
    const result = rankEligibleBotCandidates(
      [candidate({ symbol: "THIN", bidCents: toCents("90.00"), askCents: toCents("100.00") })],
      params,
    );
    expect(result).toEqual([]);
  });

  it("ranks eligible candidates by highest volume first, not by how oversold they are", () => {
    const lowVolumeMoreOversold = candidate({
      symbol: "LOWVOL",
      volume: 10_000,
      rsiPullback: { rsi: 5 },
    });
    const highVolumeLessOversold = candidate({
      symbol: "HIGHVOL",
      volume: 5_000_000,
      rsiPullback: { rsi: 28 },
    });

    const result = rankEligibleBotCandidates(
      [lowVolumeMoreOversold, highVolumeLessOversold],
      params,
    );

    expect(result.map((c) => c.symbol)).toEqual(["HIGHVOL", "LOWVOL"]);
  });

  it("returns an empty list when nothing on the watchlist currently qualifies", () => {
    const result = rankEligibleBotCandidates(
      [
        candidate({ symbol: "AAA", rsiPullback: { rsi: 60 } }),
        candidate({ symbol: "BBB", rsiPullback: { rsi: 55 } }),
      ],
      params,
    );
    expect(result).toEqual([]);
  });
});

describe("rankEligibleBotCandidates - golden_cross", () => {
  it("includes a candidate whose fast SMA crossed above its slow SMA today, ignoring its rsi_pullback signals entirely", () => {
    const result = rankEligibleBotCandidates(
      [
        candidate({
          symbol: "XOVR",
          // Would fail rsi_pullback (RSI not oversold) - proves ranking
          // under golden_cross params never looks at rsiPullback at all.
          rsiPullback: { rsi: 80 },
          goldenCross: { smaFastYesterday: 99, smaSlowYesterday: 100, smaFast: 101, smaSlow: 100 },
        }),
      ],
      GOLDEN_CROSS_V1_PARAMS,
    );
    expect(result.map((c) => c.symbol)).toEqual(["XOVR"]);
  });

  it("excludes a candidate whose fast SMA has been above its slow SMA for many days (a state, not today's crossing event)", () => {
    const result = rankEligibleBotCandidates(
      [
        candidate({
          symbol: "STALE",
          goldenCross: { smaFastYesterday: 110, smaSlowYesterday: 100, smaFast: 111, smaSlow: 100 },
        }),
      ],
      GOLDEN_CROSS_V1_PARAMS,
    );
    expect(result).toEqual([]);
  });
});

describe("rankEligibleBotCandidates - breakout", () => {
  it("includes a candidate whose close exceeds its prior rolling high with a rising SMA, ignoring its rsi_pullback/golden_cross signals entirely", () => {
    const result = rankEligibleBotCandidates(
      [
        candidate({
          symbol: "BRKOUT",
          // Would fail both other families - proves ranking under
          // breakout params never looks at either.
          rsiPullback: { rsi: 80 },
          goldenCross: { smaFast: 90, smaSlow: 100 },
          // price is $105.00 = 10500 (the candidate() default) - a new
          // high over a prior high of 10000, with the SMA rising.
          breakout: { priorHigh: 10000, smaLagged: 9900, smaToday: 10001 },
        }),
      ],
      BREAKOUT_52WK_HIGH_V1_PARAMS,
    );
    expect(result.map((c) => c.symbol)).toEqual(["BRKOUT"]);
  });

  it("excludes a candidate whose close does not exceed its prior rolling high", () => {
    const result = rankEligibleBotCandidates(
      [
        candidate({
          symbol: "NOHIGH",
          breakout: { priorHigh: 20000, smaLagged: 9900, smaToday: 10001 },
        }),
      ],
      BREAKOUT_52WK_HIGH_V1_PARAMS,
    );
    expect(result).toEqual([]);
  });

  it("excludes a candidate at a new high whose SMA isn't rising", () => {
    const result = rankEligibleBotCandidates(
      [
        candidate({
          symbol: "FLAT",
          breakout: { priorHigh: 10000, smaLagged: 10001, smaToday: 10000 },
        }),
      ],
      BREAKOUT_52WK_HIGH_V1_PARAMS,
    );
    expect(result).toEqual([]);
  });

  it("does NOT exclude a candidate that has been at/near its rolling high for many consecutive days - unlike golden_cross, breakout is deliberately not event-gated", () => {
    // "Day 5 of an ongoing breakout": today's close is still a genuine new
    // high over the trailing window (rollingHigh already ratcheted up to
    // include yesterday's new high), and the SMA is still rising - the
    // same shape of signal as the very first day of the breakout, not a
    // stale leftover. See bot-rule.ts's own comment on why this rule
    // family is intentionally NOT gated the way golden_cross is.
    const result = rankEligibleBotCandidates(
      [
        candidate({
          symbol: "ONGOING",
          breakout: { priorHigh: 10499, smaLagged: 9900, smaToday: 10001 },
        }),
      ],
      BREAKOUT_52WK_HIGH_V1_PARAMS,
    );
    expect(result.map((c) => c.symbol)).toEqual(["ONGOING"]);
  });
});
