import { describe, expect, it } from "vitest";
import { getMarketStatus, HOLIDAY_DATA_VALID_THROUGH, isMarketOpen } from "./market-hours";

// Every date below is built from an explicit UTC instant (never local time),
// so this suite behaves identically regardless of the machine or CI
// runner's own timezone. Each comment states the Eastern wall-clock time
// intended and which offset (EST = UTC-5, EDT = UTC-4) applies on that date.
function utc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

describe("isMarketOpen", () => {
  it("is open on a regular weekday at 10:00am ET", () => {
    // Wed Jun 10 2026, EDT (UTC-4): 10:00 ET = 14:00 UTC.
    expect(isMarketOpen(utc(2026, 6, 10, 14, 0))).toBe(true);
  });

  it("is closed at 9:29am ET and open at 9:30am ET (open boundary)", () => {
    // Wed Jun 10 2026, EDT: 9:29 ET = 13:29 UTC, 9:30 ET = 13:30 UTC.
    expect(isMarketOpen(utc(2026, 6, 10, 13, 29))).toBe(false);
    expect(isMarketOpen(utc(2026, 6, 10, 13, 30))).toBe(true);
  });

  it("is open at 3:59pm ET and closed at 4:00pm ET (close boundary)", () => {
    // Wed Jun 10 2026, EDT: 15:59 ET = 19:59 UTC, 16:00 ET = 20:00 UTC.
    expect(isMarketOpen(utc(2026, 6, 10, 19, 59))).toBe(true);
    expect(isMarketOpen(utc(2026, 6, 10, 20, 0))).toBe(false);
  });

  it("is closed on Saturday and Sunday", () => {
    // Sat Jun 13 2026 and Sun Jun 14 2026, at 10:00 ET (EDT, UTC-4 -> 14:00 UTC).
    expect(isMarketOpen(utc(2026, 6, 13, 14, 0))).toBe(false);
    expect(isMarketOpen(utc(2026, 6, 14, 14, 0))).toBe(false);
  });

  it("is closed on a known holiday", () => {
    // Independence Day 2026 is observed Fri Jul 3 (Jul 4 itself is a
    // Saturday). 10:00 ET, EDT -> 14:00 UTC.
    const status = getMarketStatus(utc(2026, 7, 3, 14, 0));
    expect(status.open).toBe(false);
    expect(status.reason).toBe("holiday");
  });

  it("is open at 12:00pm ET and closed at 1:30pm ET on an early-close day", () => {
    // Fri Nov 27 2026 (day after Thanksgiving), EST (UTC-5):
    // 12:00 ET = 17:00 UTC, 13:30 ET = 18:30 UTC.
    expect(isMarketOpen(utc(2026, 11, 27, 17, 0))).toBe(true);
    expect(isMarketOpen(utc(2026, 11, 27, 18, 30))).toBe(false);
  });

  it("resolves correctly in both EST (January) and EDT (July)", () => {
    // Tue Jan 20 2026, EST (UTC-5): 10:00 ET = 15:00 UTC.
    expect(isMarketOpen(utc(2026, 1, 20, 15, 0))).toBe(true);
    // Mon Jul 6 2026, EDT (UTC-4): 10:00 ET = 14:00 UTC.
    expect(isMarketOpen(utc(2026, 7, 6, 14, 0))).toBe(true);
  });

  it("resolves correctly inside the US/EU DST mismatch window", () => {
    // US DST starts Sun Mar 8 2026 (2nd Sunday of March); EU DST doesn't
    // start until Sun Mar 29 2026 (last Sunday). Thu Mar 12 2026 falls
    // inside that gap: the US is already on EDT (UTC-4) while EU is still
    // on CET (UTC+1). If this code used a fixed offset - or accidentally
    // used the host machine's (EU) DST rules - this date would resolve
    // wrong. 10:00 ET = 14:00 UTC.
    expect(isMarketOpen(utc(2026, 3, 12, 14, 0))).toBe(true);
  });
});

describe("getMarketStatus", () => {
  it("reports before_open with nextOpen later the same day", () => {
    // Wed Jun 10 2026, EDT: 9:00 ET = 13:00 UTC.
    const status = getMarketStatus(utc(2026, 6, 10, 13, 0));
    expect(status.open).toBe(false);
    expect(status.reason).toBe("before_open");
    // Next open is 9:30 ET the same day = 13:30 UTC.
    expect(status.nextOpen.toISOString()).toBe(utc(2026, 6, 10, 13, 30).toISOString());
  });

  it("reports after_close on a Friday with nextOpen skipping the weekend", () => {
    // Fri Jun 12 2026, EDT: 17:00 ET = 21:00 UTC.
    const status = getMarketStatus(utc(2026, 6, 12, 21, 0));
    expect(status.open).toBe(false);
    expect(status.reason).toBe("after_close");
    // Next open is Monday Jun 15 2026, 9:30 ET = 13:30 UTC.
    expect(status.nextOpen.toISOString()).toBe(utc(2026, 6, 15, 13, 30).toISOString());
    // Skips the weekend, so Monday is not literally "tomorrow" from Friday.
    expect(status.nextOpenIsTomorrow).toBe(false);
  });

  it("reports after_close on a Tuesday with nextOpenIsTomorrow true", () => {
    // Tue Jun 9 2026, EDT: 17:00 ET = 21:00 UTC. Wednesday is a normal
    // trading day, so the next open really is the very next calendar day.
    const status = getMarketStatus(utc(2026, 6, 9, 21, 0));
    expect(status.open).toBe(false);
    expect(status.reason).toBe("after_close");
    expect(status.nextOpen.toISOString()).toBe(utc(2026, 6, 10, 13, 30).toISOString());
    expect(status.nextOpenIsTomorrow).toBe(true);
  });

  it("reports weekend with nextOpen on the following Monday", () => {
    // Sat Jun 13 2026, EDT: 10:00 ET = 14:00 UTC.
    const status = getMarketStatus(utc(2026, 6, 13, 14, 0));
    expect(status.open).toBe(false);
    expect(status.reason).toBe("weekend");
    expect(status.nextOpen.toISOString()).toBe(utc(2026, 6, 15, 13, 30).toISOString());
  });

  it("skips both the holiday and the following weekend for nextOpen, and names the holiday", () => {
    // Fri Jul 3 2026 (observed Independence Day) is immediately followed by
    // a weekend, so the next open must skip straight to Monday Jul 6 2026.
    const status = getMarketStatus(utc(2026, 7, 3, 14, 0));
    expect(status.open).toBe(false);
    expect(status.reason).toBe("holiday");
    expect(status.nextOpen.toISOString()).toBe(utc(2026, 7, 6, 13, 30).toISOString());
    expect(status.holidayName).toBe("Independence Day (observed - Jul 4 is a Saturday)");
  });

  it("omits holidayName when the reason is not a holiday", () => {
    const status = getMarketStatus(utc(2026, 6, 13, 14, 0)); // Saturday
    expect(status.holidayName).toBeUndefined();
  });

  it("reports closesAt as 4:00pm ET and isEarlyCloseToday false on a regular trading day", () => {
    // Wed Jun 10 2026, EDT: 10:00 ET = 14:00 UTC, close 16:00 ET = 20:00 UTC.
    const status = getMarketStatus(utc(2026, 6, 10, 14, 0));
    expect(status.open).toBe(true);
    expect(status.closesAt?.toISOString()).toBe(utc(2026, 6, 10, 20, 0).toISOString());
    expect(status.isEarlyCloseToday).toBe(false);
  });

  it("reports closesAt as 1:00pm ET and isEarlyCloseToday true on an early-close day", () => {
    // Fri Nov 27 2026 (day after Thanksgiving), EST: 12:00 ET = 17:00 UTC,
    // early close 13:00 ET = 18:00 UTC.
    const status = getMarketStatus(utc(2026, 11, 27, 17, 0));
    expect(status.open).toBe(true);
    expect(status.closesAt?.toISOString()).toBe(utc(2026, 11, 27, 18, 0).toISOString());
    expect(status.isEarlyCloseToday).toBe(true);
  });

  it("omits closesAt when the market is closed", () => {
    const status = getMarketStatus(utc(2026, 6, 13, 14, 0)); // Saturday
    expect(status.open).toBe(false);
    expect(status.closesAt).toBeUndefined();
  });
});

// These three cases were found by cross-checking NYSE_HOLIDAYS against the
// official NYSE calendar - each one disproves a plausible-looking but wrong
// general rule. They exist specifically so nobody "cleans up" the data back
// into a rule-based shape later without re-breaking these dates.
describe("holiday calendar exceptions", () => {
  it("treats Jul 3, 2026 as a full closure, not an early close", () => {
    // Jul 4, 2026 falls on a Saturday, so Independence Day is observed on
    // the full day of Fri Jul 3 - not a 1:00pm early close. 10:00am ET
    // (14:00 UTC, EDT) would be open under a wrongly-assumed early close.
    const status = getMarketStatus(utc(2026, 7, 3, 14, 0));
    expect(status.open).toBe(false);
    expect(status.reason).toBe("holiday");
  });

  it("treats Dec 24, 2027 as a full closure, not the usual Christmas Eve early close", () => {
    // Dec 25, 2027 falls on a Saturday, so Christmas is observed on the
    // full day of Fri Dec 24 - not the usual Christmas Eve 1:00pm early
    // close. 10:00am ET (15:00 UTC, EST) would be open under a wrongly-
    // assumed early close.
    const status = getMarketStatus(utc(2027, 12, 24, 15, 0));
    expect(status.open).toBe(false);
    expect(status.reason).toBe("holiday");
  });

  it("does not observe New Year's Day 2028 on the preceding Friday", () => {
    // Jan 1, 2028 is a Saturday. Every other holiday in this list that
    // lands on a Saturday is observed the preceding Friday - New Year's Day
    // 2028 is a genuine exception: NYSE simply does not observe it that
    // year. Both the preceding Friday and the following Monday are normal
    // trading days.
    // Fri Dec 31, 2027, EST: 10:00 ET = 15:00 UTC.
    expect(isMarketOpen(utc(2027, 12, 31, 15, 0))).toBe(true);
    // Mon Jan 3, 2028, EST: 10:00 ET = 15:00 UTC.
    expect(isMarketOpen(utc(2028, 1, 3, 15, 0))).toBe(true);
  });
});

// This is the one deliberate exception to "every test passes an explicit
// Date" - its entire job is to compare the real current date against the
// data's boundary, so it fails in CI (not silently in production) once the
// holiday list needs extending.
describe("holiday data freshness", () => {
  it("has at least 90 days of runway before NYSE_HOLIDAYS needs extending", () => {
    const validThrough = new Date(`${HOLIDAY_DATA_VALID_THROUGH}T23:59:59Z`);
    const daysRemaining = Math.floor((validThrough.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

    expect(
      daysRemaining,
      `NYSE_HOLIDAYS/NYSE_EARLY_CLOSE_DAYS only cover dates through ${HOLIDAY_DATA_VALID_THROUGH} ` +
        `(${daysRemaining} days left). Update lib/trading/market-hours.ts with the next year's NYSE calendar.`,
    ).toBeGreaterThan(90);
  });
});
