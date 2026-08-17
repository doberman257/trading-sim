// A reusable classifier for "this Alpaca asset name looks like a fund, ETF,
// note, warrant, unit, or preferred/leveraged product rather than a single
// operating company's common stock" - built specifically so curating a
// large symbol universe (the bot's watchlist, lib/market/bot-watchlist.ts)
// never again means re-reading hundreds of names by hand the way the
// original 12-symbol Popular list did. Independent of, and a defense-in-
// depth complement to, cross-checking against a real index-constituent
// list (S&P 500 / Nasdaq-100 membership already excludes virtually all of
// these by construction) - this catches the same category of noise for any
// future curation that doesn't start from an index membership list.
//
// Deliberately name-pattern based, not exhaustive or bulletproof: a real
// operating company can still coincidentally contain one of these words
// (a company literally named "Trust Company" would false-positive). This
// is a pre-filter to reduce/flag noise in a large candidate list, not a
// legal or financial classification - always spot-check what it excludes
// before trusting a curated list built with it. See
// scripts/data/fund-name-review.json / lib/market/fund-name-review.ts for
// how a curation pipeline is expected to durably record that spot-check,
// rather than repeating it from scratch (or skipping it) on every re-run.
const FUND_OR_DERIVATIVE_NAME_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: "ETF wording", pattern: /\bETFs?\b/i },
  { label: "ETN wording", pattern: /\bETNs?\b/i },
  { label: "exchange-traded fund/note wording", pattern: /\bExchange[- ]Traded (Fund|Note)s?\b/i },
  { label: "Trust wording", pattern: /\bTrust\b/i },
  { label: "Fund wording", pattern: /\bFund\b/i },
  { label: "Warrant wording", pattern: /\bWarrants?\b/i },
  { label: "Unit wording", pattern: /\bUnits?\b/i },
  { label: "Rights wording", pattern: /\bRights?\b/i },
  { label: "Depositary Shares wording", pattern: /\bDepositary Shares?\b/i },
  { label: "Preferred wording", pattern: /\bPreferred\b/i },
  { label: "leveraged multiple wording", pattern: /\b\d[xX] (Long|Short|Bull|Bear)\b/ },
  { label: "leveraged/inverse wording", pattern: /\b(Leveraged|Inverse|Daily Target)\b/i },
  // Common fund-issuer name prefixes - these firms occasionally list a real
  // operating subsidiary too, so this is a prefix match on the raw name,
  // not a substring match, to avoid excluding something merely mentioning
  // one of these firms elsewhere in its name.
  {
    label: "fund-issuer name prefix",
    pattern:
      /^(iShares|SPDR|Invesco|Vanguard|WisdomTree|ProShares|Direxion|Global X|First Trust|VanEck|Schwab|JPMorgan Equity)\b/i,
  },
];

export function isLikelyFundOrDerivativeName(name: string): boolean {
  return FUND_OR_DERIVATIVE_NAME_PATTERNS.some(({ pattern }) => pattern.test(name));
}

// Which pattern(s) actually matched, for a human doing the review (or for a
// persisted review record's own `flagReason` - see fund-name-review.ts) to
// read without re-deriving it from the regex list by hand. Null when
// nothing matched, joined with "; " when more than one pattern matches the
// same name (rare, but real - e.g. a fund name mentioning both "ETF" and a
// leveraged multiple).
export function describeFundOrDerivativeNameMatch(name: string): string | null {
  const labels = FUND_OR_DERIVATIVE_NAME_PATTERNS.filter(({ pattern }) => pattern.test(name)).map(
    ({ label }) => label,
  );
  return labels.length > 0 ? labels.join("; ") : null;
}
