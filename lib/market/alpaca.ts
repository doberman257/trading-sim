import "server-only";
import { z } from "zod";
import { startOfExchangeDay, startOfExchangeWeek } from "../trading/market-hours";
import { toCents, type Cents } from "../trading/money";
import { isValidTwoSidedQuote } from "../trading/quote";
import type { Quote } from "../trading/types";

// Thrown by fetchQuote when Alpaca's response parses fine but reports a
// zero-priced bid or ask - a real, normal market condition (most often the
// market being closed), not a config error like the missing-credentials
// case above it. Kept as its own class, not a generic Error, so callers
// that need to treat this as an ordinary "no quote right now" outcome
// (rather than letting it propagate as an unhandled failure) can catch it
// specifically - see placeMarketOrder in lib/db/orders.ts.
export class NoTwoSidedQuoteError extends Error {
  constructor(symbol: string) {
    super(`No two-sided quote available for ${symbol} (bid or ask is zero)`);
    this.name = "NoTwoSidedQuoteError";
  }
}

const ALPACA_QUOTE_URL = "https://data.alpaca.markets/v2/stocks";
// The assets list lives on the trading API, not the market-data API - a
// different Alpaca product with its own base URL, unlike everything else
// in this file.
const ALPACA_ASSETS_URL = "https://paper-api.alpaca.markets/v2/assets";

const AlpacaQuoteResponseSchema = z.object({
  symbol: z.string(),
  quote: z.object({
    t: z.string(),
    bp: z.number(),
    ap: z.number(),
  }),
});

const RawQuoteSchema = z.object({
  t: z.string(),
  bp: z.number(),
  ap: z.number(),
});

// Alpaca omits a symbol from `quotes` entirely when it has no data for it
// (delisted, invalid, or otherwise unavailable) - it does not report a
// per-symbol error. That omission is the only signal fetchQuotes has for
// "this one symbol failed", which is why callers must check for missing
// keys rather than expect an error field.
const AlpacaMultiQuoteResponseSchema = z.object({
  quotes: z.record(z.string(), RawQuoteSchema),
});

export type QuotesResult = {
  quotes: ReadonlyMap<string, Quote>;
  // Symbols that were requested but have no quote in the result, for any
  // reason: absent from Alpaca's response, or the whole request failed
  // (network error, non-2xx status, unparsable body). Collapsing "one bad
  // symbol" and "Alpaca is down" into the same shape means callers never
  // need a separate try/catch to tell the two apart - both look like
  // "these symbols have no price right now", which is exactly what the UI
  // needs to decide what to render.
  failedSymbols: string[];
};

export async function fetchQuote(symbol: string): Promise<Quote> {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!keyId || !secretKey) {
    throw new Error("Missing ALPACA_KEY_ID or ALPACA_SECRET_KEY environment variables");
  }

  const response = await fetch(`${ALPACA_QUOTE_URL}/${symbol}/quotes/latest`, {
    headers: {
      "APCA-API-KEY-ID": keyId,
      "APCA-API-SECRET-KEY": secretKey,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Alpaca quote request for ${symbol} failed with status ${response.status}`);
  }

  const body: unknown = await response.json();
  const parsed = AlpacaQuoteResponseSchema.parse(body);

  const bidCents = toCents(parsed.quote.bp.toFixed(2));
  const askCents = toCents(parsed.quote.ap.toFixed(2));

  // Real, confirmed Alpaca behavior, not a hypothetical: it reports 0 for
  // whichever side has no active quotation right now (most often while the
  // market is closed), not an omitted field. A 0 there is nonsensical as a
  // price - passing it through would let a caller compute a negative
  // spread or, worse, fill an order at $0.00.
  if (!isValidTwoSidedQuote(bidCents, askCents)) {
    throw new NoTwoSidedQuoteError(symbol);
  }

  return {
    symbol: parsed.symbol,
    bidCents,
    askCents,
    timestamp: new Date(parsed.quote.t),
  };
}

// One request for many symbols, using Alpaca's multi-symbol endpoint -
// never call fetchQuote in a loop for a portfolio's worth of positions.
//
// Missing credentials still throw, same as fetchQuote: that's a deployment
// misconfiguration, not "Alpaca is unavailable right now", and should fail
// loudly rather than be reported as every symbol having no price. Every
// other failure mode - network error, non-2xx response, a body that
// doesn't match the expected shape - is caught and folded into
// `failedSymbols` instead of thrown, so a total Alpaca outage and a single
// bad symbol both resolve through the same QuotesResult shape.
export async function fetchQuotes(symbols: string[]): Promise<QuotesResult> {
  const uniqueSymbols = [...new Set(symbols)];

  if (uniqueSymbols.length === 0) {
    return { quotes: new Map(), failedSymbols: [] };
  }

  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!keyId || !secretKey) {
    throw new Error("Missing ALPACA_KEY_ID or ALPACA_SECRET_KEY environment variables");
  }

  try {
    const url = `${ALPACA_QUOTE_URL}/quotes/latest?symbols=${uniqueSymbols.map(encodeURIComponent).join(",")}`;
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secretKey,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return { quotes: new Map(), failedSymbols: uniqueSymbols };
    }

    const body: unknown = await response.json();
    const parsed = AlpacaMultiQuoteResponseSchema.parse(body);

    const quotes = new Map<string, Quote>();
    for (const symbol of uniqueSymbols) {
      const raw = parsed.quotes[symbol];
      if (!raw) continue;

      const bidCents = toCents(raw.bp.toFixed(2));
      const askCents = toCents(raw.ap.toFixed(2));

      // Same real Alpaca behavior as fetchQuote's single-symbol path: a
      // zero-priced side means no active quotation, not a real price.
      // Left out of `quotes` entirely so it falls into failedSymbols below
      // and every caller's existing "no quote for this symbol" rendering
      // path handles it - the same path already used for a symbol Alpaca
      // omits outright, since the two cases mean the same thing to a caller.
      if (!isValidTwoSidedQuote(bidCents, askCents)) continue;

      quotes.set(symbol, { symbol, bidCents, askCents, timestamp: new Date(raw.t) });
    }

    const failedSymbols = uniqueSymbols.filter((symbol) => !quotes.has(symbol));

    return { quotes, failedSymbols };
  } catch {
    return { quotes: new Map(), failedSymbols: uniqueSymbols };
  }
}

// Only the fields lib/db/assets.ts actually needs - Zod ignores the rest of
// what Alpaca returns (margin requirements, borrow status, etc.) rather
// than rejecting the response over fields we don't use.
const AlpacaAssetSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  exchange: z.string(),
  tradable: z.boolean(),
});

export type AlpacaAsset = z.infer<typeof AlpacaAssetSchema>;

// This is the trading API's full bulk list of active US equities - there is
// no search or pagination, and no per-symbol failure mode the way quotes
// have. It's meant to be synced into our own table and searched there (see
// lib/db/assets.ts), not called from a live request path, which is why this
// throws on any failure rather than returning a partial result: a caller
// silently treating "fetch failed" the same as "these symbols don't exist
// anymore" would be dangerous here specifically, since the sync logic uses
// omission from this list to mark existing assets no-longer-tradable.
export async function fetchTradableAssets(): Promise<AlpacaAsset[]> {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!keyId || !secretKey) {
    throw new Error("Missing ALPACA_KEY_ID or ALPACA_SECRET_KEY environment variables");
  }

  const response = await fetch(`${ALPACA_ASSETS_URL}?status=active&asset_class=us_equity`, {
    headers: {
      "APCA-API-KEY-ID": keyId,
      "APCA-API-SECRET-KEY": secretKey,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Alpaca assets request failed with status ${response.status}`);
  }

  const body: unknown = await response.json();
  return z.array(AlpacaAssetSchema).parse(body);
}

const AlpacaBarSchema = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
});

// `bars` is `null`, not `[]`, when Alpaca has no data for the requested
// symbol/range - confirmed empirically against a nonexistent symbol, which
// still returns 200. A malformed/absent field here would otherwise be a
// silent data-loss bug rather than a parse error.
const AlpacaBarsResponseSchema = z.object({
  bars: z.array(AlpacaBarSchema).nullable(),
  symbol: z.string(),
});

export type Bar = {
  // Full ISO instant of the bar's own start time - not sliced to a bare
  // date, since intraday bars need to be told apart from others on the
  // same calendar day. lib/trading/market-hours.ts's toExchangeDateKey is
  // still the right tool when a caller specifically wants the Eastern
  // trading-day a bar (or a fill) falls on.
  timestamp: string;
  openCents: Cents;
  highCents: Cents;
  lowCents: Cents;
  closeCents: Cents;
  volume: number;
};

// Shared by every bars-fetching function in this file - same conversion
// (float through a fixed 2-decimal string, never touching bigint arithmetic
// directly) either way, so it lives in one place rather than several.
function toBar(bar: z.infer<typeof AlpacaBarSchema>): Bar {
  return {
    timestamp: bar.t,
    openCents: toCents(bar.o.toFixed(2)),
    highCents: toCents(bar.h.toFixed(2)),
    lowCents: toCents(bar.l.toFixed(2)),
    closeCents: toCents(bar.c.toFixed(2)),
    volume: bar.v,
  };
}

export type BarTimeframe = "15Min" | "1Hour" | "1Day" | "1Week";

const INTRADAY_BAR_MS: Record<"15Min" | "1Hour", number> = {
  "15Min": 15 * 60 * 1000,
  "1Hour": 60 * 60 * 1000,
};

// The exact instant separating "every completed bar" from "the bar still in
// progress," for a given timeframe as of `now`. Exported for testing - this
// is the one piece of arithmetic the whole completed/live cache split in
// fetchBars depends on getting exactly right.
//
// 15Min/1Hour bars align to fixed UTC clock boundaries (:00/:15/:30/:45,
// or the top of each hour) - confirmed empirically against real Alpaca
// data - so flooring the raw UTC epoch is correct with no timezone
// conversion needed. 1Day/1Week bars align to the Eastern trading
// day/week, which does need the DST-aware conversion in market-hours.ts.
//
// This doesn't special-case market-closed hours (nights, weekends): the
// boundary still advances every 15/60 minutes even though no new bar data
// is actually being produced then, which means the completed-range cache
// key (see fetchBars) keeps changing and doesn't hit as often as it
// theoretically could outside market hours. An earlier version of this
// tried to anchor to the last trading session instead, but that broke a
// real case (a weekday evening's own, by-then-complete daily bar would
// have been silently dropped) - correctness over that extra cache-hit rate.
export function currentBarStart(timeframe: BarTimeframe, now: Date): Date {
  switch (timeframe) {
    case "15Min":
    case "1Hour": {
      const ms = INTRADAY_BAR_MS[timeframe];
      return new Date(Math.floor(now.getTime() / ms) * ms);
    }
    case "1Day":
      return startOfExchangeDay(now);
    case "1Week":
      return startOfExchangeWeek(now);
  }
}

function barsUrl(symbol: string, timeframe: BarTimeframe, start: Date, end: Date): string {
  return (
    `${ALPACA_QUOTE_URL}/${symbol}/bars?timeframe=${timeframe}` +
    `&start=${start.toISOString()}&end=${end.toISOString()}&limit=10000&feed=iex`
  );
}

// Bars for one symbol at a given timeframe, looking back `lookbackMs` from
// now. Implements CLAUDE.md's three-way caching rule for real, not just for
// daily bars: the request is split in two at currentBarStart, not just the
// response, because splitting the request is what makes the completed
// half's URL - and therefore its Next.js Data Cache key - stay identical
// for every call made during the same still-forming bar period. `cache:
// "force-cache"` explicitly opts back into caching for that one fetch even
// though the pages calling this are `force-dynamic` (which would otherwise
// default every fetch to "no-store"). The forming half is always fetched
// live and merged on afterward, exactly like the daily case already did,
// so a chart never shows a stale value for the bar still in progress.
//
// `feed=iex` is required for every timeframe, not just daily - confirmed
// empirically: the default feed 403s ("subscription does not permit
// querying recent SIP data") on any range touching recent minutes/hours,
// the same restriction found on the daily endpoint, at the same ~15-minute
// boundary regardless of bar granularity.
export async function fetchBars(
  symbol: string,
  timeframe: BarTimeframe,
  lookbackMs: number,
): Promise<Bar[]> {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!keyId || !secretKey) {
    throw new Error("Missing ALPACA_KEY_ID or ALPACA_SECRET_KEY environment variables");
  }

  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey };
  const now = new Date();
  const formingBarStart = currentBarStart(timeframe, now);
  const start = new Date(now.getTime() - lookbackMs);

  // Alpaca's `start`/`end` bars-endpoint bounds are both inclusive -
  // confirmed empirically: querying end=T and, separately, start=T for the
  // same symbol/timeframe both return the bar whose own timestamp is
  // exactly T. Without this, the completed query (end=formingBarStart) and
  // the forming query (start=formingBarStart) would both return the exact
  // bar at that boundary whenever one exists there, duplicating it in the
  // merged result below - the real bug behind two candles sharing an x
  // position. Subtracting 1ms for the completed query's end is what keeps
  // the boundary bar exclusively in the forming half, where it belongs (by
  // definition, it's the bar still forming as of `now`).
  const completedRangeEnd = new Date(formingBarStart.getTime() - 1);

  try {
    let completedBars: z.infer<typeof AlpacaBarSchema>[] = [];
    if (start < completedRangeEnd) {
      const completedResponse = await fetch(barsUrl(symbol, timeframe, start, completedRangeEnd), {
        headers,
        cache: "force-cache",
      });
      if (completedResponse.ok) {
        const body: unknown = await completedResponse.json();
        completedBars = AlpacaBarsResponseSchema.parse(body).bars ?? [];
      }
    }

    const formingResponse = await fetch(barsUrl(symbol, timeframe, formingBarStart, now), {
      headers,
      cache: "no-store",
    });
    let formingBars: z.infer<typeof AlpacaBarSchema>[] = [];
    if (formingResponse.ok) {
      const body: unknown = await formingResponse.json();
      formingBars = AlpacaBarsResponseSchema.parse(body).bars ?? [];
    }

    return dedupeBarsByTimestamp([...completedBars, ...formingBars]).map(toBar);
  } catch {
    return [];
  }
}

// Belt-and-suspenders, not the primary fix: the completed/forming query
// ranges above are constructed to never share a boundary instant in the
// first place, so this should never actually find anything to remove.
// Kept anyway as a second line of defense against the exact failure mode
// this was written to fix (two bars rendering at the same x position) -
// keeps the LAST occurrence of any timestamp, which is always the forming
// half's version when both halves somehow return the same instant, since
// forming data is the more current of the two.
function dedupeBarsByTimestamp(
  bars: z.infer<typeof AlpacaBarSchema>[],
): z.infer<typeof AlpacaBarSchema>[] {
  const byTimestamp = new Map<string, z.infer<typeof AlpacaBarSchema>>();
  for (const bar of bars) {
    byTimestamp.set(bar.t, bar);
  }
  return [...byTimestamp.values()];
}

// A symbol with no data in range is omitted from `bars` entirely (not
// present as null or an empty array) - confirmed empirically by mixing a
// nonexistent symbol into a real batch request.
const AlpacaMultiBarsResponseSchema = z.object({
  bars: z.record(z.string(), z.array(AlpacaBarSchema)),
});

const SPARKLINE_LOOKBACK_DAYS = 30;

// Confirmed empirically against the real endpoint, not assumed: `limit=10000`
// succeeds, `limit=10001` 400s with "invalid limit: larger than the allowed
// maximum of 10000" - this is Alpaca's own hard ceiling on this endpoint,
// not a conservative choice made up for this app. The limit caps the TOTAL
// bars across every symbol in one request, not per symbol (confirmed
// separately - a `limit` smaller than that total silently returns only the
// first symbols' bars and drops the rest, with no error), which is exactly
// what makes a large symbol count matter here even though the per-symbol
// lookback itself is short.
const ALPACA_MULTI_BARS_LIMIT_MAX = 10000;

// How many symbols can share one request without risking the silent-
// truncation failure mode above. Chunking on calendar lookbackDays (not the
// smaller true trading-day count) is deliberately conservative - trading
// days are always <= calendar days, so this always stays under the real cap
// even though it under-fills each chunk slightly. Found this the hard way:
// this function worked fine at the original 12-symbol bot watchlist
// (12 * ~70 trading days over a 100-day lookback is ~840 bars, nowhere near
// 10,000) and silently returned only 150 of 517 symbols the moment the
// watchlist was expanded - same failure mode as the comment above describes,
// just never triggered until a caller's symbol count grew enough to hit it.
function maxSymbolsPerBarsChunk(lookbackDays: number): number {
  return Math.max(1, Math.floor(ALPACA_MULTI_BARS_LIMIT_MAX / lookbackDays));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function fetchDailyBarsChunk(
  symbols: readonly string[],
  lookbackDays: number,
  headers: Record<string, string>,
): Promise<Map<string, Bar[]>> {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const symbolsParam = symbols.map(encodeURIComponent).join(",");

  const url =
    `${ALPACA_QUOTE_URL}/bars?symbols=${symbolsParam}&timeframe=1Day` +
    `&start=${start.toISOString()}&end=${end.toISOString()}&limit=${ALPACA_MULTI_BARS_LIMIT_MAX}&feed=iex`;

  try {
    const response = await fetch(url, { headers, cache: "no-store" });
    if (!response.ok) {
      return new Map();
    }

    const body: unknown = await response.json();
    const parsed = AlpacaMultiBarsResponseSchema.parse(body);

    const result = new Map<string, Bar[]>();
    for (const symbol of symbols) {
      const bars = parsed.bars[symbol];
      if (bars) {
        result.set(
          symbol,
          bars.map((bar) => toBar(bar)),
        );
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

// One or more requests for many symbols' daily bars, using Alpaca's
// multi-symbol bars endpoint - the same batching this file already does for
// quotes (fetchQuotes), applied here so a watchlist or positions list with N
// symbols costs a handful of network calls, not N. Originally built for
// sparklines (see components/Sparkline.tsx: a short, fixed lookback, not the
// full chart's 90 days) and later reused by the bot's selection cycle
// (lib/db/bot-runs.ts) with a much larger symbol count - which is what
// surfaced the need for the chunking above.
//
// Symbols are split into chunks that each stay under Alpaca's real
// ALPACA_MULTI_BARS_LIMIT_MAX, fetched concurrently (Promise.all - even the
// bot's full ~517-symbol watchlist at its 100-day lookback is only a
// handful of chunks, nowhere near the 200 req/min rate limit Alpaca's own
// response headers report), and merged into one map. Each chunk soft-fails
// to contributing no symbols on its own error, same as fetchQuotes and for
// the same reason - one bad chunk (or the whole call, when there's only
// one) shouldn't make an otherwise-successful fetch look like a total
// failure. `feed=iex` is required for the same reason as fetchBars (the
// default feed 403s on recent-day ranges).
export async function fetchDailyBarsForSymbols(
  symbols: string[],
  lookbackDays: number = SPARKLINE_LOOKBACK_DAYS,
): Promise<Map<string, Bar[]>> {
  const uniqueSymbols = [...new Set(symbols)];

  if (uniqueSymbols.length === 0) {
    return new Map();
  }

  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!keyId || !secretKey) {
    throw new Error("Missing ALPACA_KEY_ID or ALPACA_SECRET_KEY environment variables");
  }

  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey };
  const chunks = chunk(uniqueSymbols, maxSymbolsPerBarsChunk(lookbackDays));
  const chunkResults = await Promise.all(
    chunks.map((chunkSymbols) => fetchDailyBarsChunk(chunkSymbols, lookbackDays, headers)),
  );

  const result = new Map<string, Bar[]>();
  for (const chunkResult of chunkResults) {
    for (const [symbol, bars] of chunkResult) {
      result.set(symbol, bars);
    }
  }
  return result;
}
