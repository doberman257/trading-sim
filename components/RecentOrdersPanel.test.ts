import { describe, expect, it } from "vitest";
import { formatOrderTimestamp } from "./RecentOrdersPanel";

function utc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

describe("formatOrderTimestamp", () => {
  const now = utc(2026, 8, 5, 15, 32);

  it('shows "just now" for anything under a minute old', () => {
    expect(formatOrderTimestamp(utc(2026, 8, 5, 15, 32), now)).toBe("just now");
    expect(formatOrderTimestamp(new Date(now.getTime() - 59_000), now)).toBe("just now");
  });

  it("shows whole minutes for anything under an hour old", () => {
    expect(formatOrderTimestamp(new Date(now.getTime() - 60_000), now)).toBe("1m ago");
    expect(formatOrderTimestamp(new Date(now.getTime() - 59 * 60_000), now)).toBe("59m ago");
  });

  it("shows whole hours for anything under a day old", () => {
    expect(formatOrderTimestamp(new Date(now.getTime() - 60 * 60_000), now)).toBe("1h ago");
    expect(formatOrderTimestamp(new Date(now.getTime() - 23 * 60 * 60_000), now)).toBe("23h ago");
  });

  it("falls back to a short absolute date at exactly 24 hours and beyond", () => {
    expect(formatOrderTimestamp(new Date(now.getTime() - 24 * 60 * 60_000), now)).toBe("Aug 4");
  });

  it("omits the year when the order was placed this year", () => {
    expect(formatOrderTimestamp(utc(2026, 1, 2, 10, 0), now)).toBe("Jan 2");
  });

  it("includes the year when the order was placed in a previous year", () => {
    expect(formatOrderTimestamp(utc(2025, 12, 31, 10, 0), now)).toBe("Dec 31, 2025");
  });

  it("never wraps: the relative and absolute forms are both a single short token", () => {
    // A crude but effective wrap guard for a dense table cell - anything
    // this long at this density is the wrapping bug resurfacing.
    const samples = [
      formatOrderTimestamp(new Date(now.getTime() - 5_000), now),
      formatOrderTimestamp(new Date(now.getTime() - 5 * 60_000), now),
      formatOrderTimestamp(new Date(now.getTime() - 5 * 60 * 60_000), now),
      formatOrderTimestamp(utc(2025, 12, 31, 10, 0), now),
    ];
    for (const sample of samples) {
      expect(sample.length).toBeLessThanOrEqual(12);
    }
  });
});
