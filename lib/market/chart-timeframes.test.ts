import { describe, expect, it } from "vitest";
import {
  allowedTimeframesForRange,
  CHART_RANGES,
  isValidTimeframeForRange,
  nearestValidTimeframe,
  timeframeIncompatibilityReason,
} from "./chart-timeframes";

describe("isValidTimeframeForRange", () => {
  it("disallows 15-minute bars over a 1-year range - the paradigm 'too many bars' case", () => {
    expect(isValidTimeframeForRange("1Y", "15Min")).toBe(false);
  });

  it("disallows 15-minute bars over a 3-month range", () => {
    expect(isValidTimeframeForRange("3M", "15Min")).toBe(false);
  });

  it("allows 15-minute bars over a 1-week range", () => {
    expect(isValidTimeframeForRange("1W", "15Min")).toBe(true);
  });

  it("allows daily bars at every range", () => {
    for (const range of CHART_RANGES) {
      expect(isValidTimeframeForRange(range, "1Day")).toBe(true);
    }
  });

  it("disallows weekly bars over a 1-week range - not 'too many', but still not the intent", () => {
    expect(isValidTimeframeForRange("1W", "1Week")).toBe(false);
  });

  it("every range allows at least one timeframe", () => {
    for (const range of CHART_RANGES) {
      expect(allowedTimeframesForRange(range).length).toBeGreaterThan(0);
    }
  });
});

describe("timeframeIncompatibilityReason", () => {
  it("returns null for a valid combination", () => {
    expect(timeframeIncompatibilityReason("1Y", "1Day")).toBeNull();
  });

  it("says too-many-bars when the timeframe is finer than everything the range allows", () => {
    expect(timeframeIncompatibilityReason("1Y", "15Min")).toBe("too-many-bars");
    expect(timeframeIncompatibilityReason("3M", "15Min")).toBe("too-many-bars");
  });

  it("says too-few-bars when the timeframe is coarser than everything the range allows", () => {
    // The exact bug reported in production: 1Week bars over a 1W range
    // (~1 bar) were disabled with a "too many bars" message, backwards.
    expect(timeframeIncompatibilityReason("1W", "1Week")).toBe("too-few-bars");
  });
});

describe("nearestValidTimeframe", () => {
  it("keeps the current timeframe when it's already valid for the new range", () => {
    expect(nearestValidTimeframe("1W", "1Hour")).toBe("1Hour");
  });

  it("falls back to a coarser timeframe when switching to a longer range invalidates the current one", () => {
    // 15Min is invalid at 1Y; 1Hour is also invalid at 1Y; 1Day is the
    // first valid coarser option.
    expect(nearestValidTimeframe("1Y", "15Min")).toBe("1Day");
  });

  it("falls back from 1Hour to 1Day when switching to a 1-year range", () => {
    expect(nearestValidTimeframe("1Y", "1Hour")).toBe("1Day");
  });

  it("falls back to a finer timeframe when switching to a shorter range invalidates a coarse one", () => {
    // 1Week is invalid at 1W; nothing coarser than 1Week exists, so it
    // falls back to the finest valid option in the other direction.
    expect(nearestValidTimeframe("1W", "1Week")).toBe("1Day");
  });

  it("never returns a timeframe invalid for the given range, across every combination", () => {
    const allTimeframes: Parameters<typeof nearestValidTimeframe>[1][] = [
      "15Min",
      "1Hour",
      "1Day",
      "1Week",
    ];
    for (const range of CHART_RANGES) {
      for (const timeframe of allTimeframes) {
        const result = nearestValidTimeframe(range, timeframe);
        expect(isValidTimeframeForRange(range, result)).toBe(true);
      }
    }
  });
});
