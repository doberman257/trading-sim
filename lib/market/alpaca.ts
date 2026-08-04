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
