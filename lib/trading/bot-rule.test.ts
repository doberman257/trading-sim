import { describe, expect, it } from "vitest";
import {
  BREAKOUT_52WK_HIGH_V1_ID,
  BREAKOUT_52WK_HIGH_V1_PARAMS,
  describeBotRuleLabel,
  describeBotRuleParams,
  GOLDEN_CROSS_V1_ID,
  GOLDEN_CROSS_V1_PARAMS,
  maxHoldDays,
  parseRuleParams,
  RSI_PULLBACK_UPTREND_V1_ID,
  RSI_PULLBACK_UPTREND_V1_PARAMS,
  RSI_PULLBACK_UPTREND_V2_ID,
  RSI_PULLBACK_UPTREND_V2_PARAMS,
  ruleShouldEnter,
  ruleShouldExit,
  type RuleEvaluation,
} from "./bot-rule";
import { toCents } from "./money";

const params = RSI_PULLBACK_UPTREND_V1_PARAMS; // rsiEntry 30, rsiExit 50, sma period unused here

function rsiPullbackEval(
  overrides: Partial<{ rsi: number; price: bigint; sma: number }> = {},
): RuleEvaluation {
  return {
    kind: "rsi_pullback",
    params,
    signals: { rsi: 25, price: toCents("105.00"), sma: 10000, ...overrides },
  };
}

describe("ruleShouldEnter - RSI oversold within an uptrend", () => {
  it("enters when RSI is below the entry threshold and price sits above the SMA", () => {
    expect(ruleShouldEnter(rsiPullbackEval())).toBe(true);
  });

  it("does not enter when RSI is oversold but price is below the SMA (a falling knife, not a pullback)", () => {
    expect(ruleShouldEnter(rsiPullbackEval({ price: toCents("95.00") }))).toBe(false);
  });

  it("does not enter when price is above the SMA but RSI is not oversold", () => {
    expect(ruleShouldEnter(rsiPullbackEval({ rsi: 45 }))).toBe(false);
  });

  it("treats the entry threshold as strict (RSI exactly at 30 does not enter)", () => {
    expect(ruleShouldEnter(rsiPullbackEval({ rsi: 30 }))).toBe(false);
  });

  it("treats the SMA comparison as strict (price exactly at the SMA does not enter)", () => {
    expect(ruleShouldEnter(rsiPullbackEval({ price: toCents("100.00") }))).toBe(false);
  });
});

// Only the entry-threshold DELTA between v1 and v2 needs coverage here -
// the "falling knife" and SMA-strictness cases above already prove
// ruleShouldEnter's generic behavior for any params object, v2's included,
// so re-testing them against v2's numbers would just be the same
// assertions with a different threshold, not new coverage. See
// lib/trading/bot-rule.ts's AVAILABLE_STRATEGIES and STATE.md for why the
// threshold moved from 30 to 40.
describe("ruleShouldEnter - v2's raised entry threshold (40, not 30)", () => {
  it("enters at RSI 35, which v1 would reject but v2 accepts", () => {
    expect(ruleShouldEnter(rsiPullbackEval({ rsi: 35 }))).toBe(false);
    expect(
      ruleShouldEnter({
        kind: "rsi_pullback",
        params: RSI_PULLBACK_UPTREND_V2_PARAMS,
        signals: { rsi: 35, price: toCents("105.00"), sma: 10000 },
      }),
    ).toBe(true);
  });

  it("treats v2's entry threshold as strict (RSI exactly at 40 does not enter)", () => {
    expect(
      ruleShouldEnter({
        kind: "rsi_pullback",
        params: RSI_PULLBACK_UPTREND_V2_PARAMS,
        signals: { rsi: 40, price: toCents("105.00"), sma: 10000 },
      }),
    ).toBe(false);
  });

  it("leaves everything else (SMA period, exit threshold, RSI period) unchanged from v1", () => {
    expect(RSI_PULLBACK_UPTREND_V2_PARAMS).toMatchObject({
      rsiPeriod: params.rsiPeriod,
      rsiExitThreshold: params.rsiExitThreshold,
      smaPeriod: params.smaPeriod,
    });
  });
});

describe("ruleShouldExit - RSI recovery", () => {
  it("exits once RSI recovers above the exit threshold", () => {
    expect(ruleShouldExit({ kind: "rsi_pullback", params, signals: { rsi: 55 } })).toBe(true);
  });

  it("does not exit while RSI is still at or below the exit threshold", () => {
    expect(ruleShouldExit({ kind: "rsi_pullback", params, signals: { rsi: 50 } })).toBe(false);
    expect(ruleShouldExit({ kind: "rsi_pullback", params, signals: { rsi: 35 } })).toBe(false);
  });
});

describe("ruleShouldEnter - golden cross (trend structure, an event not a state)", () => {
  function goldenCrossEval(
    signals: Partial<{
      smaFast: number;
      smaFastYesterday: number;
      smaSlow: number;
      smaSlowYesterday: number;
    }> = {},
  ): RuleEvaluation {
    return {
      kind: "golden_cross",
      params: GOLDEN_CROSS_V1_PARAMS,
      signals: {
        smaFastYesterday: 99,
        smaSlowYesterday: 100,
        smaFast: 101,
        smaSlow: 100,
        ...signals,
      },
    };
  }

  it("enters on the exact day the fast SMA crosses above the slow SMA", () => {
    expect(ruleShouldEnter(goldenCrossEval())).toBe(true);
  });

  it("does not enter when the fast SMA was already above the slow SMA yesterday - the cross already happened, this is a state, not today's event", () => {
    expect(
      ruleShouldEnter(
        goldenCrossEval({
          smaFastYesterday: 102,
          smaSlowYesterday: 100,
          smaFast: 103,
          smaSlow: 100,
        }),
      ),
    ).toBe(false);
  });

  // The exact scenario the design brief called out: a stock sits with the
  // fast SMA above the slow SMA for many consecutive days after a real
  // cross. Re-evaluating "today, is fast > slow" in isolation on ANY of
  // those later days would say yes every time - a bot run started on day
  // 10 of that stretch must not treat "still in the state" the same as
  // "the cross just happened", or it would buy in well after the actual
  // signal, potentially at a much worse price, every single day the
  // stretch continued.
  it("does not re-enter on day 10 of an established uptrend, even though the fast SMA is still above the slow SMA", () => {
    const dayTenOfStretch = goldenCrossEval({
      smaFastYesterday: 110,
      smaSlowYesterday: 100,
      smaFast: 111,
      smaSlow: 100,
    });
    expect(ruleShouldEnter(dayTenOfStretch)).toBe(false);
  });

  it("does not enter when the fast SMA is at, but not above, the slow SMA today (strict comparison)", () => {
    expect(ruleShouldEnter(goldenCrossEval({ smaFast: 100, smaSlow: 100 }))).toBe(false);
  });

  it("enters when yesterday the fast SMA was exactly equal to the slow SMA (the <= boundary), and today it's above", () => {
    expect(ruleShouldEnter(goldenCrossEval({ smaFastYesterday: 100, smaSlowYesterday: 100 }))).toBe(
      true,
    );
  });
});

describe("ruleShouldExit - golden cross reversal", () => {
  it("exits once the fast SMA falls back below the slow SMA", () => {
    expect(ruleShouldExit({ kind: "golden_cross", signals: { smaFast: 99, smaSlow: 100 } })).toBe(
      true,
    );
  });

  it("does not exit while the fast SMA is still at or above the slow SMA", () => {
    expect(ruleShouldExit({ kind: "golden_cross", signals: { smaFast: 100, smaSlow: 100 } })).toBe(
      false,
    );
    expect(ruleShouldExit({ kind: "golden_cross", signals: { smaFast: 105, smaSlow: 100 } })).toBe(
      false,
    );
  });
});

describe("ruleShouldEnter - breakout_52wk_high_v1 (momentum, deliberately not event-gated)", () => {
  function breakoutEval(
    signals: Partial<{
      price: bigint;
      priorHigh: number;
      smaToday: number;
      smaLagged: number;
    }> = {},
  ): RuleEvaluation {
    return {
      kind: "breakout",
      params: BREAKOUT_52WK_HIGH_V1_PARAMS,
      signals: {
        price: toCents("105.00"),
        priorHigh: 10000,
        smaToday: 10001,
        smaLagged: 9900,
        ...signals,
      },
    };
  }

  it("enters when today's close is a new high over the prior rolling window and the SMA is rising", () => {
    expect(ruleShouldEnter(breakoutEval())).toBe(true);
  });

  it("does not enter when today's close does not exceed the prior rolling high", () => {
    expect(ruleShouldEnter(breakoutEval({ priorHigh: 20000 }))).toBe(false);
  });

  it("treats the new-high comparison as strict (price exactly at the prior high does not enter)", () => {
    expect(ruleShouldEnter(breakoutEval({ price: toCents("100.00"), priorHigh: 10000 }))).toBe(
      false,
    );
  });

  it("does not enter at a new high whose SMA isn't rising", () => {
    expect(ruleShouldEnter(breakoutEval({ smaToday: 9900, smaLagged: 10001 }))).toBe(false);
  });

  // The explicit decision this rule needed, called out in the design brief:
  // a stock can sit at/near its own rolling high for many consecutive days,
  // the same shape of situation golden_cross needed event-gating for. This
  // rule is deliberately NOT gated the same way - see bot-rule.ts's own
  // comment on ruleShouldEnter for why (the rolling-high threshold itself
  // ratchets up with each new high, so a later day's comparison is against
  // an already-updated, non-stale window, not a leftover from days ago).
  // Proven here at the pure-function level: "yesterday also passed" is not
  // even part of this rule's own signal shape (unlike golden_cross's
  // smaFastYesterday/smaSlowYesterday), so there is no state to gate on -
  // day 5 of an ongoing breakout evaluates identically to day 1, by design.
  it("does not gate on any prior day's signal - day 5 of an ongoing breakout still enters, exactly like day 1 would", () => {
    // priorHigh has already ratcheted up close to today's close (as it
    // would after several consecutive days of new highs), and today is
    // still, genuinely, a new high over that already-updated window.
    const dayFiveOfBreakout = breakoutEval({
      price: toCents("105.00"),
      priorHigh: 10499,
      smaToday: 10050,
      smaLagged: 9950,
    });
    expect(ruleShouldEnter(dayFiveOfBreakout)).toBe(true);
  });
});

describe("ruleShouldExit - breakout_52wk_high_v1 trend reversal", () => {
  it("exits once price falls back below the exit SMA", () => {
    expect(
      ruleShouldExit({ kind: "breakout", signals: { price: toCents("99.00"), sma: 10000 } }),
    ).toBe(true);
  });

  it("does not exit while price is still at or above the exit SMA", () => {
    expect(
      ruleShouldExit({ kind: "breakout", signals: { price: toCents("100.00"), sma: 10000 } }),
    ).toBe(false);
    expect(
      ruleShouldExit({ kind: "breakout", signals: { price: toCents("110.00"), sma: 10000 } }),
    ).toBe(false);
  });
});

describe("parseRuleParams", () => {
  it("round-trips a current rsi_pullback params object", () => {
    expect(parseRuleParams(RSI_PULLBACK_UPTREND_V2_PARAMS)).toEqual(RSI_PULLBACK_UPTREND_V2_PARAMS);
  });

  it("round-trips a golden_cross params object", () => {
    expect(parseRuleParams(GOLDEN_CROSS_V1_PARAMS)).toEqual(GOLDEN_CROSS_V1_PARAMS);
  });

  it("round-trips a breakout params object", () => {
    expect(parseRuleParams(BREAKOUT_52WK_HIGH_V1_PARAMS)).toEqual(BREAKOUT_52WK_HIGH_V1_PARAMS);
  });

  // Every bot_runs row that exists in the real database as of this change
  // was written before `kind` existed at all - only rsi_pullback ever
  // existed then, so this must still parse correctly without a data
  // migration backfilling the field onto already-recorded production rows.
  it("infers kind: rsi_pullback for a legacy stored params object with no kind field", () => {
    const legacy = {
      rsiPeriod: 14,
      rsiEntryThreshold: 40,
      rsiExitThreshold: 50,
      smaPeriod: 50,
    };
    expect(parseRuleParams(legacy)).toEqual({ ...legacy, kind: "rsi_pullback" });
  });

  it("returns null, not a throw, for something unparseable", () => {
    expect(parseRuleParams({ garbage: true })).toBeNull();
    expect(parseRuleParams(null)).toBeNull();
    expect(parseRuleParams("not even an object")).toBeNull();
  });
});

describe("describeBotRuleLabel", () => {
  it("uses AVAILABLE_STRATEGIES' own curated label for a live, registered ruleId", () => {
    expect(describeBotRuleLabel(RSI_PULLBACK_UPTREND_V2_ID, RSI_PULLBACK_UPTREND_V2_PARAMS)).toBe(
      "RSI Pullback",
    );
    expect(describeBotRuleLabel(GOLDEN_CROSS_V1_ID, GOLDEN_CROSS_V1_PARAMS)).toBe("Golden Cross");
    expect(describeBotRuleLabel(BREAKOUT_52WK_HIGH_V1_ID, BREAKOUT_52WK_HIGH_V1_PARAMS)).toBe(
      "52-Week High Breakout",
    );
  });

  // v1 is real, current production data (see the two real "selecting" runs
  // still recorded under it as of this round) - not a hypothetical case.
  it("falls back to a generic per-family label for a superseded, unregistered ruleId like v1", () => {
    expect(describeBotRuleLabel(RSI_PULLBACK_UPTREND_V1_ID, RSI_PULLBACK_UPTREND_V1_PARAMS)).toBe(
      "RSI Pullback",
    );
  });

  it("infers the right family even from a legacy stored object with no kind field", () => {
    const legacy = { rsiPeriod: 14, rsiEntryThreshold: 30, rsiExitThreshold: 50, smaPeriod: 50 };
    expect(describeBotRuleLabel("some_old_unregistered_id", legacy)).toBe("RSI Pullback");
  });

  it("falls back to the raw ruleId itself when ruleParams can't be parsed at all", () => {
    expect(describeBotRuleLabel("some_corrupt_row", { garbage: true })).toBe("some_corrupt_row");
  });
});

describe("describeBotRuleParams", () => {
  it("summarizes rsi_pullback params", () => {
    expect(describeBotRuleParams(RSI_PULLBACK_UPTREND_V2_PARAMS)).toBe("RSI<40, SMA(50)");
  });

  it("summarizes golden_cross params", () => {
    expect(describeBotRuleParams(GOLDEN_CROSS_V1_PARAMS)).toBe("SMA(20)×SMA(50)");
  });

  it("summarizes breakout params", () => {
    expect(describeBotRuleParams(BREAKOUT_52WK_HIGH_V1_PARAMS)).toBe("365d high, SMA rising 20d");
  });

  it("returns null, not a throw, for something unparseable", () => {
    expect(describeBotRuleParams({ garbage: true })).toBeNull();
    expect(describeBotRuleParams(null)).toBeNull();
  });
});

describe("maxHoldDays", () => {
  it("is null for rsi_pullback - same-day-only, unchanged (deliberate design choice, see the params' own comment)", () => {
    expect(maxHoldDays("rsi_pullback")).toBeNull();
  });

  it("is 30 for golden_cross and breakout - a real, deliberately-accepted cap (see each params constant's own comment for the real historical binding rate)", () => {
    expect(maxHoldDays("golden_cross")).toBe(30);
    expect(maxHoldDays("breakout")).toBe(30);
  });
});
