import { describe, expect, it } from "vitest";
import { isApproachingMarketClose } from "./bot-day-expiry";

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
