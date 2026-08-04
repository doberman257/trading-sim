import { existsSync } from "node:fs";
import { fetchQuote } from "../lib/market/alpaca";
import { getMarketStatus } from "../lib/trading/market-hours";
import { formatCents } from "../lib/trading/money";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

const symbol = process.argv[2];

if (!symbol) {
  console.error("Usage: npm run quote -- <SYMBOL>");
  process.exit(1);
}

const MARKET_CLOSED_REASON_LABEL: Record<string, string> = {
  weekend: "weekend",
  holiday: "holiday",
  before_open: "before today's open",
  after_close: "after today's close",
};

function printMarketStatus(): void {
  const status = getMarketStatus(new Date());
  const nextOpenEastern = status.nextOpen.toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });

  if (status.open) {
    console.log(`Market: OPEN (next opens ${nextOpenEastern} ET after today's close)`);
  } else {
    const reason = status.reason ? MARKET_CLOSED_REASON_LABEL[status.reason] : "unknown reason";
    console.log(`Market: CLOSED (${reason}) - next open ${nextOpenEastern} ET`);
  }
}

printMarketStatus();

fetchQuote(symbol)
  .then((quote) => {
    console.log(
      `${quote.symbol}  bid=${formatCents(quote.bidCents)}  ask=${formatCents(quote.askCents)}  at ${quote.timestamp.toISOString()}`,
    );
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
