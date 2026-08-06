import { describe, expect, it } from "vitest";
import { describeAssetSyncStatus } from "./assetSyncMessages";

function utc(year: number, month: number, day: number, hour = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour));
}

describe("describeAssetSyncStatus", () => {
  it("reports 'never' when there is no successful sync on record", () => {
    const status = describeAssetSyncStatus(null, utc(2026, 6, 10));
    expect(status.level).toBe("never");
    expect(status.message).toMatch(/never been synced/);
  });

  it("reports 'ok' with no day count for a sync within the last day", () => {
    const lastSync = utc(2026, 6, 10, 0);
    const now = utc(2026, 6, 10, 12);
    expect(describeAssetSyncStatus(lastSync, now)).toEqual({
      level: "ok",
      message: "Stock list updated within the last day.",
    });
  });

  it("reports 'ok' with a singular day count at exactly one day", () => {
    const lastSync = utc(2026, 6, 9);
    const now = utc(2026, 6, 10);
    expect(describeAssetSyncStatus(lastSync, now)).toEqual({
      level: "ok",
      message: "Stock list updated 1 day ago.",
    });
  });

  it("reports 'ok' with a plural day count for several days", () => {
    const lastSync = utc(2026, 6, 5);
    const now = utc(2026, 6, 10);
    expect(describeAssetSyncStatus(lastSync, now)).toEqual({
      level: "ok",
      message: "Stock list updated 5 days ago.",
    });
  });

  it("escalates to 'stale' at exactly the 7-day threshold", () => {
    const lastSync = utc(2026, 6, 3);
    const now = utc(2026, 6, 10);
    const status = describeAssetSyncStatus(lastSync, now);
    expect(status.level).toBe("stale");
    expect(status.message).toBe(
      "Stock list last updated 7 days ago — search may not reflect recent listings or delistings.",
    );
  });

  it("stays 'ok' one day short of the threshold", () => {
    const lastSync = utc(2026, 6, 4);
    const now = utc(2026, 6, 10);
    expect(describeAssetSyncStatus(lastSync, now).level).toBe("ok");
  });
});
