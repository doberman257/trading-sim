import { describe, expect, it } from "vitest";
import { RSI_PULLBACK_UPTREND_V1_PARAMS } from "./bot-rule";
import { rankEligibleBotCandidates, type BotCandidate } from "./bot-selection";
import { toCents } from "./money";

const params = RSI_PULLBACK_UPTREND_V1_PARAMS;

function candidate(overrides: Partial<BotCandidate> & { symbol: string }): BotCandidate {
  return {
    bidCents: toCents("99.50"),
    askCents: toCents("100.00"),
    volume: 1_000_000,
    rsi: 25,
    price: toCents("105.00"),
    sma: 10000,
    ...overrides,
  };
}

describe("rankEligibleBotCandidates", () => {
  it("excludes a candidate that does not satisfy the entry rule", () => {
    const result = rankEligibleBotCandidates([candidate({ symbol: "AAA", rsi: 45 })], params);
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
    const lowVolumeMoreOversold = candidate({ symbol: "LOWVOL", rsi: 5, volume: 10_000 });
    const highVolumeLessOversold = candidate({ symbol: "HIGHVOL", rsi: 28, volume: 5_000_000 });

    const result = rankEligibleBotCandidates(
      [lowVolumeMoreOversold, highVolumeLessOversold],
      params,
    );

    expect(result.map((c) => c.symbol)).toEqual(["HIGHVOL", "LOWVOL"]);
  });

  it("returns an empty list when nothing on the watchlist currently qualifies", () => {
    const result = rankEligibleBotCandidates(
      [candidate({ symbol: "AAA", rsi: 60 }), candidate({ symbol: "BBB", rsi: 55 })],
      params,
    );
    expect(result).toEqual([]);
  });
});
