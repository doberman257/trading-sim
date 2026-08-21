import { describe, expect, it } from "vitest";
import {
  effectiveDeadline,
  isApproachingMarketClose,
  nextApplicableCloseTime,
} from "./bot-day-expiry";

// A real Tuesday, no holiday, no early close - 2026-08-11 (per STATE.md's
// "currentDate" context this session runs on 2026-08-12, so this is simply
// the day before, chosen because it's a plain regular trading day).
describe("isApproachingMarketClose", () => {
  it("is false well before the close", () => {
    // 9:35am ET = 13:35 UTC - just after the open, nowhere near the
    // 120-minute buffer before the 4:00pm ET close.
    expect(isApproachingMarketClose(new Date("2026-08-11T13:35:00Z"))).toBe(false);
  });

  it("is true within the buffer window before the 4:00pm ET close", () => {
    // 3:55pm ET = 19:55 UTC - 5 minutes before close, well inside the
    // 120-minute buffer.
    expect(isApproachingMarketClose(new Date("2026-08-11T19:55:00Z"))).toBe(true);
  });

  // The buffer's own real boundary, not just a comfortably-interior point -
  // DAY_EXPIRY_BUFFER_MS's own comment explains why 120 minutes (not the
  // original 10) is the real number now; these two cases are what would
  // actually catch a future session quietly shrinking it back down without
  // re-measuring.
  it("is true exactly at the buffer boundary (120 minutes before close)", () => {
    // 2:00pm ET = 18:00 UTC - exactly 120 minutes before the 4:00pm close.
    expect(isApproachingMarketClose(new Date("2026-08-11T18:00:00Z"))).toBe(true);
  });

  it("is false one minute outside the buffer boundary (121 minutes before close)", () => {
    // 1:59pm ET = 17:59 UTC - 121 minutes before the 4:00pm close.
    expect(isApproachingMarketClose(new Date("2026-08-11T17:59:00Z"))).toBe(false);
  });

  it("is false once the market has actually closed", () => {
    // 4:05pm ET = 20:05 UTC.
    expect(isApproachingMarketClose(new Date("2026-08-11T20:05:00Z"))).toBe(false);
  });

  it("is false on a weekend, when the market was never open to begin with", () => {
    // 2026-08-15 is a Saturday.
    expect(isApproachingMarketClose(new Date("2026-08-15T19:55:00Z"))).toBe(false);
  });
});

describe("nextApplicableCloseTime", () => {
  it("returns today's own close when the market is open right now", () => {
    // 9:35am ET = 13:35 UTC, same Tuesday - market is open.
    expect(nextApplicableCloseTime(new Date("2026-08-11T13:35:00Z"))).toEqual(
      new Date("2026-08-11T20:00:00Z"), // 4:00pm ET
    );
  });

  it("returns the NEXT session's close, not today's already-passed one, when called after hours the same day", () => {
    // 5:00pm ET = 21:00 UTC, same Tuesday - market already closed for the
    // day. The next session is Wednesday 2026-08-12.
    expect(nextApplicableCloseTime(new Date("2026-08-11T21:00:00Z"))).toEqual(
      new Date("2026-08-12T20:00:00Z"),
    );
  });

  it("returns Monday's close, not a weekend date, when called on a weekend", () => {
    // 2026-08-15 is a Saturday; the next session is Monday 2026-08-17.
    expect(nextApplicableCloseTime(new Date("2026-08-15T15:00:00Z"))).toEqual(
      new Date("2026-08-17T20:00:00Z"),
    );
  });
});

describe("effectiveDeadline", () => {
  const entryFilledAt = new Date("2026-08-11T14:00:00Z");

  it("is null for rsi_pullback with no user deadline - same-day close is the only boundary, unchanged", () => {
    expect(effectiveDeadline("rsi_pullback", entryFilledAt, null)).toBeNull();
  });

  it("is the user's own deadline for rsi_pullback when one is set - no strategy cap to compare against", () => {
    const userDeadline = new Date("2026-08-11T18:00:00Z");
    expect(effectiveDeadline("rsi_pullback", entryFilledAt, userDeadline)).toEqual(userDeadline);
  });

  it("is entryFilledAt + 30 days for golden_cross/breakout with no user deadline", () => {
    const expected = new Date(entryFilledAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(effectiveDeadline("golden_cross", entryFilledAt, null)).toEqual(expected);
    expect(effectiveDeadline("breakout", entryFilledAt, null)).toEqual(expected);
  });

  it("takes the user's own EARLIER deadline over the 30-day cap when the user chose sooner", () => {
    const earlierUserDeadline = new Date(entryFilledAt.getTime() + 10 * 24 * 60 * 60 * 1000);
    expect(effectiveDeadline("golden_cross", entryFilledAt, earlierUserDeadline)).toEqual(
      earlierUserDeadline,
    );
  });

  // The real point of this function: a user's own deadline can only pull an
  // exit EARLIER than the strategy's own cap, never override it later -
  // even though createBotRun's own validation should already prevent a
  // deadline this late from ever being stored, this is the real,
  // structural backstop in case a run sat "selecting" long enough that a
  // creation-time deadline estimate ends up looser than the true
  // entry-based cap by the time it's evaluated.
  it("takes the strategy's own 30-day cap over a user deadline that would be LATER, never the later one", () => {
    const laterUserDeadline = new Date(entryFilledAt.getTime() + 45 * 24 * 60 * 60 * 1000);
    const expectedCap = new Date(entryFilledAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(effectiveDeadline("golden_cross", entryFilledAt, laterUserDeadline)).toEqual(
      expectedCap,
    );
  });

  it("is null when there's no cap and no user deadline and no entry date at all (still selecting)", () => {
    expect(effectiveDeadline("rsi_pullback", null, null)).toBeNull();
  });

  it("is still the user's own deadline even with no entry date yet (a capped rule's run still selecting)", () => {
    const userDeadline = new Date("2026-08-11T18:00:00Z");
    expect(effectiveDeadline("golden_cross", null, userDeadline)).toEqual(userDeadline);
  });
});
