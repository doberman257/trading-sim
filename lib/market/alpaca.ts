import "server-only";
import { z } from "zod";
import { toCents } from "../trading/money";
import type { Quote } from "../trading/types";

const ALPACA_QUOTE_URL = "https://data.alpaca.markets/v2/stocks";

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
