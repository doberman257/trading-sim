import { describe, expect, it } from "vitest";
import { RSI_PULLBACK_UPTREND_V1_PARAMS, ruleShouldEnter, ruleShouldExit } from "./bot-rule";
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

describe("ruleShouldExit - RSI recovery", () => {
  it("exits once RSI recovers above the exit threshold", () => {
    expect(ruleShouldExit({ rsi: 55 }, params)).toBe(true);
  });

  it("does not exit while RSI is still at or below the exit threshold", () => {
    expect(ruleShouldExit({ rsi: 50 }, params)).toBe(false);
    expect(ruleShouldExit({ rsi: 35 }, params)).toBe(false);
  });
});
