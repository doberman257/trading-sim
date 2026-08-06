import "server-only";
import { z } from "zod";
import { toCents, type Cents } from "../trading/money";
import type { Quote } from "../trading/types";

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

  return {
    symbol: parsed.symbol,
    // Alpaca returns floats; convert through a fixed 2-decimal string so the
    // float never touches bigint arithmetic directly.
    bidCents: toCents(parsed.quote.bp.toFixed(2)),
    askCents: toCents(parsed.quote.ap.toFixed(2)),
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
      if (raw) {
        quotes.set(symbol, {
          symbol,
          bidCents: toCents(raw.bp.toFixed(2)),
          askCents: toCents(raw.ap.toFixed(2)),
          timestamp: new Date(raw.t),
        });
      }
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

export type DailyBar = {
  date: string; // "YYYY-MM-DD"
  openCents: Cents;
  highCents: Cents;
  lowCents: Cents;
  closeCents: Cents;
  volume: number;
};

const DAILY_BARS_LOOKBACK_DAYS = 90;

// Daily bars, most recent `DAILY_BARS_LOOKBACK_DAYS` calendar days - enough
// for a short-history chart without pulling more than needed.
//
// Always fetched live (`cache: "no-store"`), even though most of what comes
// back is completed, immutable history that CLAUDE.md's caching rule would
// allow caching aggressively. This endpoint mixes both cases in one
// response - today's still-forming bar rides along with every closed day
// (confirmed empirically: the most recent bar on a trading day is today's,
// with a fraction of a normal day's volume) - and this function has no
// per-symbol cache to begin with, so splitting the response to cache only
// the closed days would add real complexity for a page that loads this
// once per visit, not a hot path the way quotes are. Simplicity over an
// optimization nothing here currently needs.
//
// `feed=iex` is required, not optional: the default feed is SIP, which
// 403s ("subscription does not permit querying recent SIP data") on this
// free-tier account for any range touching recent days - confirmed
// empirically. Quotes don't need this because their default feed doesn't
// hit the same restriction; bars does.
export async function fetchDailyBars(symbol: string): Promise<DailyBar[]> {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;

  if (!keyId || !secretKey) {
    throw new Error("Missing ALPACA_KEY_ID or ALPACA_SECRET_KEY environment variables");
  }

  const end = new Date();
  const start = new Date(end.getTime() - DAILY_BARS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const url =
    `${ALPACA_QUOTE_URL}/${symbol}/bars?timeframe=1Day` +
    `&start=${start.toISOString()}&end=${end.toISOString()}&limit=${DAILY_BARS_LOOKBACK_DAYS}&feed=iex`;

  try {
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secretKey,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const body: unknown = await response.json();
    const parsed = AlpacaBarsResponseSchema.parse(body);

    return (parsed.bars ?? []).map((bar) => ({
      date: bar.t.slice(0, 10),
      // Alpaca returns floats; convert through a fixed 2-decimal string so
      // the float never touches bigint arithmetic directly - same
      // conversion fetchQuote uses.
      openCents: toCents(bar.o.toFixed(2)),
      highCents: toCents(bar.h.toFixed(2)),
      lowCents: toCents(bar.l.toFixed(2)),
      closeCents: toCents(bar.c.toFixed(2)),
      volume: bar.v,
    }));
  } catch {
    return [];
  }
}
