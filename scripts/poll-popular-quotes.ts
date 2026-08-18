// Diagnostic tool, not part of the app - polls Alpaca's raw quotes endpoint
// directly (same technique as the standalone closing-bell investigation
// script: bypasses fetchQuote/fetchQuotes entirely, so this only ever
// tells us about Alpaca's own data, never this app's parsing of it) for
// every symbol in the Popular list, every POLL_INTERVAL_MS, for as long as
// the market is open. Built to answer one specific open question: does the
// zero-priced-ask pattern found at today's close (AAPL/MSFT/NVDA/META)
// also happen during active intraday trading, or only in the closing
// seconds? See STATE.md for the investigation this is closing out.
//
// Self-pacing, not externally scheduled - start it any time (before or
// during market hours) and it waits for the open itself via this app's own
// isMarketOpen, then polls until isMarketOpen goes false again, then exits.
// No need to time a cron/launch precisely.
//
// Every observation is appended to the log file immediately
// (appendFileSync, not buffered) so a kill partway through never loses
// data already collected - "log as you go," not just a final summary.
//
// Usage: npm run poll-popular-quotes  (leave running; safe to Ctrl+C any
// time, everything logged so far is already on disk)
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes - same cadence as the worker routes elsewhere in this app.
const WAIT_FOR_OPEN_CHECK_MS = 60 * 1000; // While waiting for the open, check every minute, not every 5.

type RawQuote = {
  t: string;
  bp: number;
  ap: number;
  bx?: string;
  ax?: string;
};

function etTimeString(date: Date): string {
  return date.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
}

async function main(): Promise<void> {
  const { POPULAR_SYMBOLS } = await import("../lib/market/popular-symbols");
  const { isValidTwoSidedQuote } = await import("../lib/trading/quote");
  const { isMarketOpen, getMarketStatus } = await import("../lib/trading/market-hours");
  const { toCents } = await import("../lib/trading/money");

  const symbols = POPULAR_SYMBOLS.map((s) => s.symbol);
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!keyId || !secretKey) {
    console.error("Missing ALPACA_KEY_ID or ALPACA_SECRET_KEY.");
    process.exit(1);
  }
  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey };

  mkdirSync("logs", { recursive: true });
  const dateKey = new Date().toISOString().slice(0, 10);
  const logPath = `logs/popular-quote-poll-${dateKey}.jsonl`;
  console.log(`Logging to ${logPath}`);
  console.log(`Watching: ${symbols.join(", ")}`);

  // Wait for the open, if started early - checked against this app's own
  // real market-hours logic, not a hardcoded clock assumption.
  while (!isMarketOpen(new Date())) {
    const status = getMarketStatus(new Date());
    console.log(
      `[${new Date().toISOString()}] Market closed (next open ${status.nextOpen.toISOString()}) - waiting...`,
    );
    await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_OPEN_CHECK_MS));
  }

  console.log(
    `[${new Date().toISOString()}] Market open - polling every ${POLL_INTERVAL_MS / 60_000} minutes.`,
  );

  const firstInvalidSeenAt = new Map<string, string>();
  const invalidPollCount = new Map<string, number>();
  let totalPolls = 0;

  while (isMarketOpen(new Date())) {
    const pollTime = new Date();
    totalPolls++;

    try {
      const url = `https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=${symbols.join(",")}`;
      const res = await fetch(url, { headers, cache: "no-store" });

      if (!res.ok) {
        const line = JSON.stringify({
          pollTime: pollTime.toISOString(),
          pollTimeET: etTimeString(pollTime),
          error: `HTTP ${res.status}`,
        });
        appendFileSync(logPath, line + "\n");
        console.log(`[${etTimeString(pollTime)}] Request failed: HTTP ${res.status}`);
      } else {
        const body = (await res.json()) as { quotes: Record<string, RawQuote> };
        const invalidThisPoll: string[] = [];

        for (const symbol of symbols) {
          const raw = body.quotes[symbol];
          const bidCents = raw ? toCents(raw.bp.toFixed(2)) : null;
          const askCents = raw ? toCents(raw.ap.toFixed(2)) : null;
          const valid =
            bidCents !== null && askCents !== null && isValidTwoSidedQuote(bidCents, askCents);

          const line = JSON.stringify({
            pollTime: pollTime.toISOString(),
            pollTimeET: etTimeString(pollTime),
            symbol,
            present: raw !== undefined,
            quoteTimestamp: raw?.t ?? null,
            bidRaw: raw?.bp ?? null,
            askRaw: raw?.ap ?? null,
            bidExchange: raw?.bx ?? null,
            askExchange: raw?.ax ?? null,
            valid,
          });
          appendFileSync(logPath, line + "\n");

          if (!valid) {
            invalidThisPoll.push(symbol);
            invalidPollCount.set(symbol, (invalidPollCount.get(symbol) ?? 0) + 1);
            if (!firstInvalidSeenAt.has(symbol)) {
              firstInvalidSeenAt.set(
                symbol,
                `${pollTime.toISOString()} (${etTimeString(pollTime)} ET)`,
              );
            }
          }
        }

        if (invalidThisPoll.length === 0) {
          console.log(`[${etTimeString(pollTime)}] ${symbols.length}/${symbols.length} valid.`);
        } else {
          console.log(
            `[${etTimeString(pollTime)}] ${symbols.length - invalidThisPoll.length}/${symbols.length} valid - INVALID: ${invalidThisPoll.join(", ")}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendFileSync(
        logPath,
        JSON.stringify({ pollTime: pollTime.toISOString(), error: message }) + "\n",
      );
      console.log(`[${etTimeString(pollTime)}] Poll threw: ${message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.log(
    `\n[${new Date().toISOString()}] Market closed - stopping. Total polls: ${totalPolls}`,
  );
  console.log("Per-symbol invalid-poll counts (0 = never invalid all session):");
  for (const symbol of symbols) {
    const count = invalidPollCount.get(symbol) ?? 0;
    const firstSeen = firstInvalidSeenAt.get(symbol);
    console.log(
      `  ${symbol}: ${count} invalid poll(s)${firstSeen ? `, first at ${firstSeen}` : ""}`,
    );
  }
  console.log(`\nFull log: ${logPath}`);

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
