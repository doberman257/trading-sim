import { describe, expect, it } from "vitest";
import { getMarketStatus } from "@/lib/trading/market-hours";
import { closedMessage, openMessage } from "./MarketStatusBanner";

// Mirrors lib/trading/market-hours.test.ts's convention: every date is an
// explicit UTC instant, never local/system time, so this suite is
// deterministic regardless of when or where it runs.
function utc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

describe("openMessage", () => {
  it("states the regular close time without implying it's an early close", () => {
    // Wed Jun 10 2026, EDT: 10:00 ET = 14:00 UTC, regular close 4:00pm ET.
    const status = getMarketStatus(utc(2026, 6, 10, 14, 0));
    expect(openMessage(status)).toBe("Market open · closes at 4:00 PM ET");
  });

  it("calls out an early close explicitly, not just a different time", () => {
    // Fri Nov 27 2026 (day after Thanksgiving): early close at 1:00pm ET.
    const status = getMarketStatus(utc(2026, 11, 27, 17, 0));
    expect(openMessage(status)).toBe("Market open · closes at 1:00 PM ET (early close)");
  });
});

describe("closedMessage", () => {
  it("says only the time, not a weekday, when the open is later today", () => {
    // Wed Jun 10 2026, EDT: 9:00 ET, before the 9:30 open - "opens
    // Wednesday" would wrongly read as a different, later Wednesday.
    const status = getMarketStatus(utc(2026, 6, 10, 13, 0));
    expect(closedMessage(status)).toBe("Market opens at 9:30 AM ET.");
  });

  it('says "tomorrow" when the next trading day is the very next calendar day', () => {
    // Tue Jun 9 2026 after close - Wednesday is a normal trading day.
    const status = getMarketStatus(utc(2026, 6, 9, 21, 0));
    expect(closedMessage(status)).toBe("Market closed — opens tomorrow at 9:30 AM ET.");
  });

  it("names the actual weekday when the next open skips the weekend", () => {
    // Fri Jun 12 2026 after close - next open is Monday, not "tomorrow".
    const status = getMarketStatus(utc(2026, 6, 12, 21, 0));
    expect(closedMessage(status)).toBe("Market closed — opens Monday at 9:30 AM ET.");
  });

  it("names the weekend explicitly, distinct from an ordinary after-close message", () => {
    // Sat Jun 13 2026.
    const status = getMarketStatus(utc(2026, 6, 13, 14, 0));
    expect(closedMessage(status)).toBe(
      "Market closed for the weekend — opens Monday at 9:30 AM ET.",
    );
  });

  it("names the specific holiday, not just the generic reason", () => {
    // Fri Jul 3 2026, observed Independence Day.
    const status = getMarketStatus(utc(2026, 7, 3, 14, 0));
    expect(closedMessage(status)).toBe(
      "Market closed for Independence Day (observed - Jul 4 is a Saturday) — opens Monday at 9:30 AM ET.",
    );
  });
});
