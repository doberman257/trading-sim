import { describe, expect, it } from "vitest";
import {
  RSI_PULLBACK_UPTREND_V1_PARAMS,
  RSI_PULLBACK_UPTREND_V2_PARAMS,
  ruleShouldEnter,
  ruleShouldExit,
} from "./bot-rule";
import { toCents } from "./money";

const params = RSI_PULLBACK_UPTREND_V1_PARAMS; // rsiEntry 30, rsiExit 50, sma period unused here

describe("ruleShouldEnter - RSI oversold within an uptrend", () => {
  it("enters when RSI is below the entry threshold and price sits above the SMA", () => {
    expect(ruleShouldEnter({ rsi: 25, price: toCents("105.00"), sma: 10000 }, params)).toBe(true);
  });

  it("does not enter when RSI is oversold but price is below the SMA (a falling knife, not a pullback)", () => {
    expect(ruleShouldEnter({ rsi: 25, price: toCents("95.00"), sma: 10000 }, params)).toBe(false);
  });

  it("does not enter when price is above the SMA but RSI is not oversold", () => {
    expect(ruleShouldEnter({ rsi: 45, price: toCents("105.00"), sma: 10000 }, params)).toBe(false);
  });

  it("treats the entry threshold as strict (RSI exactly at 30 does not enter)", () => {
    expect(ruleShouldEnter({ rsi: 30, price: toCents("105.00"), sma: 10000 }, params)).toBe(false);
  });

  it("treats the SMA comparison as strict (price exactly at the SMA does not enter)", () => {
    expect(ruleShouldEnter({ rsi: 25, price: toCents("100.00"), sma: 10000 }, params)).toBe(false);
  });
});

// Only the entry-threshold DELTA between v1 and v2 needs coverage here -
// the "falling knife" and SMA-strictness cases above already prove
// ruleShouldEnter's generic behavior for any params object, v2's included,
// so re-testing them against v2's numbers would just be the same
// assertions with a different threshold, not new coverage. See
// lib/trading/bot-rule.ts's ACTIVE_RULE_ID/PARAMS and STATE.md for why the
// threshold moved from 30 to 40.
describe("ruleShouldEnter - v2's raised entry threshold (40, not 30)", () => {
  it("enters at RSI 35, which v1 would reject but v2 accepts", () => {
    expect(ruleShouldEnter({ rsi: 35, price: toCents("105.00"), sma: 10000 }, params)).toBe(false);
    expect(
      ruleShouldEnter(
        { rsi: 35, price: toCents("105.00"), sma: 10000 },
        RSI_PULLBACK_UPTREND_V2_PARAMS,
      ),
    ).toBe(true);
  });

  it("treats v2's entry threshold as strict (RSI exactly at 40 does not enter)", () => {
    expect(
      ruleShouldEnter(
        { rsi: 40, price: toCents("105.00"), sma: 10000 },
        RSI_PULLBACK_UPTREND_V2_PARAMS,
      ),
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
    expect(ruleShouldExit({ rsi: 55 }, params)).toBe(true);
  });

  it("does not exit while RSI is still at or below the exit threshold", () => {
    expect(ruleShouldExit({ rsi: 50 }, params)).toBe(false);
    expect(ruleShouldExit({ rsi: 35 }, params)).toBe(false);
  });
});
