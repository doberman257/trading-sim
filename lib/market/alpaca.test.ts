import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toCents } from "../trading/money";
import { fetchQuotes } from "./alpaca";

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
