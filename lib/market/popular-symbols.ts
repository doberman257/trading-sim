// A hand-picked starting set for Discover's "Popular" list, for a user with
// nothing specific in mind - not derived from any Alpaca endpoint. Alpaca's
// most-actives/movers endpoints exist but were rejected during the discovery
// research: they work, but surface low-quality, noisy results (thinly-traded
// tickers spiking on volume) unsuitable for a first-run browsing screen.
// Every symbol/name here was verified against the real synced assets table
// (see lib/db/assets.ts) to exist and be tradable.
export type PopularSymbol = {
  symbol: string;
  name: string;
};

export const POPULAR_SYMBOLS: readonly PopularSymbol[] = [
  { symbol: "AAPL", name: "Apple Inc." },
  { symbol: "MSFT", name: "Microsoft Corporation" },
  { symbol: "GOOGL", name: "Alphabet Inc." },
  { symbol: "AMZN", name: "Amazon.com, Inc." },
  { symbol: "NVDA", name: "NVIDIA Corporation" },
  { symbol: "META", name: "Meta Platforms, Inc." },
  { symbol: "TSLA", name: "Tesla, Inc." },
  { symbol: "NFLX", name: "Netflix, Inc." },
  { symbol: "JPM", name: "JPMorgan Chase & Co." },
  { symbol: "V", name: "VISA Inc." },
  { symbol: "WMT", name: "Walmart Inc." },
  { symbol: "DIS", name: "The Walt Disney Company" },
];

// The autonomous bot's curated selection universe (lib/db/bot-runs.ts) -
// reuses this exact list rather than inventing a separate one, since every
// symbol here is already verified against the real synced assets table
// (see the comment above). Honest scope limit, not a design decision: the
// bot design proposal called for "a few hundred liquid names," and this is
// 12 - hand-curating a few hundred verified tickers is a real, separate
// data-curation task this round didn't do. Exported as its own constant so
// growing this list later (the actual fix) is a one-line change here, not a
// bot-runs.ts rewrite - see STATE.md's deferred list.
export const BOT_WATCHLIST_SYMBOLS: readonly string[] = POPULAR_SYMBOLS.map(
  (entry) => entry.symbol,
);
