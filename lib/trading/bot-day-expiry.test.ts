import { describe, expect, it } from "vitest";
import { isApproachingMarketClose } from "./bot-day-expiry";

// A real Tuesday, no holiday, no early close - 2026-08-11 (per STATE.md's
// "currentDate" context this session runs on 2026-08-12, so this is simply
// the day before, chosen because it's a plain regular trading day).
describe("isApproachingMarketClose", () => {
  it("is false well before the close", () => {
    // 11:00am ET = 15:00 UTC.
    expect(isApproachingMarketClose(new Date("2026-08-11T15:00:00Z"))).toBe(false);
  });

  it("is true within the buffer window before the 4:00pm ET close", () => {
    // 3:55pm ET = 19:55 UTC - 5 minutes before close, inside the 10-minute buffer.
    expect(isApproachingMarketClose(new Date("2026-08-11T19:55:00Z"))).toBe(true);
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
