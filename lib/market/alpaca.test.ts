import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toCents } from "../trading/money";
import { currentBarStart, fetchBars, fetchQuotes } from "./alpaca";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  process.env.ALPACA_KEY_ID = "test-key";
  process.env.ALPACA_SECRET_KEY = "test-secret";
});

afterEach(() => {
  delete process.env.ALPACA_KEY_ID;
  delete process.env.ALPACA_SECRET_KEY;
  vi.unstubAllGlobals();
});

describe("fetchQuotes", () => {
  it("returns an empty result without calling fetch when given no symbols", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchQuotes([]);

    expect(result).toEqual({ quotes: new Map(), failedSymbols: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches every requested symbol in a single request", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        quotes: {
          AAPL: { t: "2026-08-05T14:00:00Z", bp: 99, ap: 100 },
          TSLA: { t: "2026-08-05T14:00:00Z", bp: 199, ap: 200 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchQuotes(["AAPL", "TSLA"]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.failedSymbols).toEqual([]);
    expect(result.quotes.get("AAPL")).toMatchObject({
      bidCents: toCents("99.00"),
      askCents: toCents("100.00"),
    });
    expect(result.quotes.get("TSLA")).toMatchObject({
      bidCents: toCents("199.00"),
      askCents: toCents("200.00"),
    });
  });

  it("does not discard good data when one symbol is missing from the response", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        quotes: {
          AAPL: { t: "2026-08-05T14:00:00Z", bp: 99, ap: 100 },
          // TSLA absent - Alpaca's way of signalling no data for it.
        },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchQuotes(["AAPL", "TSLA"]);

    expect(result.quotes.has("AAPL")).toBe(true);
    expect(result.quotes.has("TSLA")).toBe(false);
    expect(result.failedSymbols).toEqual(["TSLA"]);
  });

  it("reports every requested symbol as failed when the request itself fails, without throwing", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchQuotes(["AAPL", "TSLA"]);

    expect(result).toEqual({ quotes: new Map(), failedSymbols: ["AAPL", "TSLA"] });
  });

  it("reports every requested symbol as failed when fetch throws, without throwing itself", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchQuotes(["AAPL"]);

    expect(result).toEqual({ quotes: new Map(), failedSymbols: ["AAPL"] });
  });

  it("deduplicates repeated symbols into a single request", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ quotes: { AAPL: { t: "2026-08-05T14:00:00Z", bp: 99, ap: 100 } } }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await fetchQuotes(["AAPL", "AAPL"]);

    const requestedUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(requestedUrl.match(/AAPL/g)).toHaveLength(1);
  });

  it("still throws when Alpaca credentials are missing - that's a config error, not a market-data failure", async () => {
    delete process.env.ALPACA_KEY_ID;

    await expect(fetchQuotes(["AAPL"])).rejects.toThrow(/Missing ALPACA_KEY_ID/);
  });
});

// Every date is an explicit UTC instant, mirroring lib/trading/market-hours.test.ts's
// convention, so this suite is deterministic regardless of when/where it runs.
function utc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

describe("currentBarStart", () => {
  it("floors 15Min to the most recent :00/:15/:30/:45 UTC boundary", () => {
    expect(currentBarStart("15Min", utc(2026, 6, 10, 14, 37))).toEqual(utc(2026, 6, 10, 14, 30));
  });

  it("returns the exact instant unchanged when already on a 15Min boundary", () => {
    expect(currentBarStart("15Min", utc(2026, 6, 10, 14, 30))).toEqual(utc(2026, 6, 10, 14, 30));
  });

  it("floors 1Hour to the top of the current hour", () => {
    expect(currentBarStart("1Hour", utc(2026, 6, 10, 14, 59))).toEqual(utc(2026, 6, 10, 14, 0));
  });

  it("floors 1Day to midnight Eastern (EDT) of the current day", () => {
    expect(currentBarStart("1Day", utc(2026, 6, 10, 18, 0))).toEqual(utc(2026, 6, 10, 4, 0));
  });

  it("floors 1Day to midnight Eastern (EST) of the current day", () => {
    expect(currentBarStart("1Day", utc(2026, 1, 7, 18, 0))).toEqual(utc(2026, 1, 7, 5, 0));
  });

  it("floors 1Week to midnight Eastern Monday of the current week", () => {
    // Wed Jun 10 2026 -> Monday Jun 8 2026, midnight EDT.
    expect(currentBarStart("1Week", utc(2026, 6, 10, 18, 0))).toEqual(utc(2026, 6, 8, 4, 0));
  });
});

describe("fetchBars", () => {
  // Alpaca's bars endpoint `start`/`end` bounds are both inclusive -
  // confirmed empirically against the real API: querying end=T and,
  // separately, start=T both return the bar whose own timestamp is exactly
  // T. If the completed query's `end` and the forming query's `start` were
  // the same instant (both derived from currentBarStart), a real bar
  // sitting exactly on that boundary would come back from both requests
  // and render twice at the same x position on the chart - the actual bug
  // this test guards against.
  it("requests the completed and forming ranges with non-overlapping boundaries", async () => {
    const requestedUrls: string[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      return jsonResponse({ bars: [], symbol: "AAPL" });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await fetchBars("AAPL", "15Min", 24 * 60 * 60 * 1000);

    expect(requestedUrls).toHaveLength(2);
    const completedEnd = new Date(new URL(requestedUrls[0]!).searchParams.get("end")!);
    const formingStart = new Date(new URL(requestedUrls[1]!).searchParams.get("start")!);

    // Strictly after, not equal or before - equal is exactly the bug (see
    // above), and before would mean re-requesting some of the completed
    // range as "live" for no reason.
    expect(formingStart.getTime()).toBeGreaterThan(completedEnd.getTime());
    // Exactly 1ms, not just "some gap": large enough to exclude the exact
    // boundary bar, small enough to never accidentally exclude or
    // duplicate the previous real bar too (bars are always spaced at
    // least a minute apart, even at the finest supported timeframe).
    expect(formingStart.getTime() - completedEnd.getTime()).toBe(1);
  });

  it("does not return a duplicate bar even if the completed and forming responses somehow overlap", async () => {
    // Belt-and-suspenders test for dedupeBarsByTimestamp, independent of
    // the query-construction test above - simulates the failure mode
    // directly (both raw responses containing the same instant) rather
    // than relying on the non-overlap invariant holding.
    const sharedTimestamp = "2026-08-06T13:30:00Z";
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          bars: [
            { t: "2026-08-06T13:15:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 1000 },
            // Stale version of the boundary bar, as it looked when the
            // completed request happened to catch it mid-formation.
            { t: sharedTimestamp, o: 100.5, h: 102, l: 100, c: 101, v: 500 },
          ],
          symbol: "AAPL",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          bars: [
            // The same bar, now further along/closed - the forming
            // response's version should win.
            { t: sharedTimestamp, o: 100.5, h: 105, l: 100, c: 104, v: 2000 },
            { t: "2026-08-06T13:45:00Z", o: 104, h: 106, l: 103, c: 105, v: 1500 },
          ],
          symbol: "AAPL",
        }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const bars = await fetchBars("AAPL", "15Min", 24 * 60 * 60 * 1000);

    const timestamps = bars.map((bar) => bar.timestamp);
    expect(timestamps).toEqual(["2026-08-06T13:15:00Z", sharedTimestamp, "2026-08-06T13:45:00Z"]);
    expect(new Set(timestamps).size).toBe(timestamps.length);

    const sharedBar = bars.find((bar) => bar.timestamp === sharedTimestamp);
    // The forming (later-fetched) version, not the completed/stale one -
    // close 104, not 101.
    expect(sharedBar?.closeCents).toBe(toCents("104.00"));
  });
});
