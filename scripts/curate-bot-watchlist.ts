// Regenerates the candidate list for lib/market/bot-watchlist.ts from the
// real synced assets table, cross-checked against a real, independent
// liquid-large/mid-cap reference (S&P 500 + Nasdaq-100 constituents,
// scripts/data/index-reference-tickers.json - see that file's own
// `sources`/`sourcedAt` for where the snapshot came from and how to refresh
// it). This is a curation aid, not something run automatically: it prints
// its findings for review, and lib/market/bot-watchlist.ts itself stays a
// static, hand-reviewed list (same reasoning as lib/market/popular-symbols.ts
// - baking in a reviewed result rather than deriving the live trading
// universe from a network fetch on every run).
//
// A name the classifier flags (lib/market/fund-name.ts) is checked against
// scripts/data/fund-name-review.json, the durable record of every such name
// a human has already looked at - see lib/market/fund-name-review.ts for the
// three-state logic. A flagged name with NO entry there is a genuinely new
// case (most likely: this year's index reconstitution added a symbol whose
// name happens to match one of the classifier's patterns) and this script
// deliberately STOPS - exits non-zero and prints a NEEDS REVIEW section -
// rather than guessing whether to keep or drop it. This is expected,
// correct behavior on a re-run after a reconstitution, not a bug: add an
// entry to fund-name-review.json (decision + a short rationale) for each
// symbol it lists, then re-run.
//
// Usage: npm run curate-bot-watchlist (see package.json)
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

type ReferenceData = {
  sourcedAt: string;
  sources: string[];
  sp500: string[];
  nasdaq100: string[];
};

type ReviewData = {
  reviewedAt: string;
  entries: Array<{
    symbol: string;
    flagReason: string;
    decision: "kept" | "excluded";
    rationale: string;
  }>;
};

async function main(): Promise<void> {
  const { db } = await import("../lib/db/client");
  const { assets } = await import("../lib/db/schema");
  const { inArray } = await import("drizzle-orm");
  const { describeFundOrDerivativeNameMatch } = await import("../lib/market/fund-name");
  const { classifyForReview } = await import("../lib/market/fund-name-review");

  const reference = JSON.parse(
    readFileSync("scripts/data/index-reference-tickers.json", "utf8"),
  ) as ReferenceData;
  const referenceTickers = [...new Set([...reference.sp500, ...reference.nasdaq100])].sort();

  console.log(
    `Reference universe: ${reference.sp500.length} S&P 500 + ${reference.nasdaq100.length} ` +
      `Nasdaq-100 tickers (${referenceTickers.length} unique) from ${reference.sourcedAt}.`,
  );

  const review = JSON.parse(
    readFileSync("scripts/data/fund-name-review.json", "utf8"),
  ) as ReviewData;
  const reviewedEntries = new Map(review.entries.map((entry) => [entry.symbol, entry]));
  console.log(
    `Fund-name review file: ${review.entries.length} prior decisions (${review.reviewedAt}).`,
  );

  const rows = await db
    .select({
      symbol: assets.symbol,
      name: assets.name,
      exchange: assets.exchange,
      tradable: assets.tradable,
    })
    .from(assets)
    .where(inArray(assets.symbol, referenceTickers));

  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  const notFound = referenceTickers.filter((t) => !bySymbol.has(t));

  const eligible = rows.filter(
    (r) => r.tradable && (r.exchange === "NYSE" || r.exchange === "NASDAQ"),
  );
  const wrongExchangeOrUntradable = rows.filter(
    (r) => !(r.tradable && (r.exchange === "NYSE" || r.exchange === "NASDAQ")),
  );

  console.log(`\nMatched in assets table: ${rows.length} / ${referenceTickers.length}`);
  console.log(`Not found in assets table at all: ${notFound.length}`);
  if (notFound.length > 0) console.log(`  ${notFound.join(", ")}`);

  console.log(
    `\nFound but excluded (not tradable, or not NYSE/NASDAQ): ${wrongExchangeOrUntradable.length}`,
  );
  for (const r of wrongExchangeOrUntradable) {
    console.log(`  ${r.symbol}  tradable=${r.tradable}  exchange=${r.exchange}  ${r.name}`);
  }

  const included: typeof eligible = [];
  const reviewedExcluded: typeof eligible = [];
  const needsReview: typeof eligible = [];

  for (const r of eligible) {
    const classification = classifyForReview(r.symbol, r.name, reviewedEntries);
    switch (classification.status) {
      case "not-flagged":
      case "reviewed-kept":
        included.push(r);
        break;
      case "reviewed-excluded":
        reviewedExcluded.push(r);
        break;
      case "needs-review":
        needsReview.push(r);
        break;
    }
  }

  if (reviewedExcluded.length > 0) {
    console.log(`\nExcluded per a prior fund-name review decision: ${reviewedExcluded.length}`);
    for (const r of reviewedExcluded) {
      const entry = reviewedEntries.get(r.symbol)!;
      console.log(`  ${r.symbol}  ${r.name}  - ${entry.rationale}`);
    }
  }

  if (needsReview.length > 0) {
    console.error(
      `\n=== NEEDS REVIEW: ${needsReview.length} symbol(s) flagged by isLikelyFundOrDerivativeName ` +
        `with no entry in scripts/data/fund-name-review.json ===`,
    );
    for (const r of needsReview) {
      const reason = describeFundOrDerivativeNameMatch(r.name) ?? "unknown";
      console.error(`  ${r.symbol}  ${r.name}  (flagReason: ${reason})`);
    }
    console.error(
      `\nAdd an entry to scripts/data/fund-name-review.json for each symbol above ` +
        `(decision: "kept" or "excluded", plus a short rationale), then re-run this script. ` +
        `Not printing a candidate list - a flagged, unreviewed symbol must never silently end up ` +
        `in (or out of) a list that places real, if paper, trades.`,
    );
    process.exit(1);
  }

  const final = included.toSorted((a, b) => a.symbol.localeCompare(b.symbol));
  console.log(`\nFinal curated count: ${final.length}`);
  console.log("\n--- TS array, symbol+name pairs ---");
  for (const r of final) {
    console.log(`  { symbol: ${JSON.stringify(r.symbol)}, name: ${JSON.stringify(r.name)} },`);
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
