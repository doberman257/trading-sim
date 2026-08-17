import { isLikelyFundOrDerivativeName } from "./fund-name";

// A durable record of a human decision about one symbol the name-pattern
// classifier flagged - see scripts/data/fund-name-review.json for the real,
// persisted set and scripts/curate-bot-watchlist.ts for how it's used. This
// is the actual audit trail for "was this false positive checked," not this
// conversation's own history - a fact this app can't query and a future
// session has no way to rediscover on its own.
export type FundNameReviewDecision = "kept" | "excluded";

export type FundNameReviewEntry = {
  symbol: string;
  // What describeFundOrDerivativeNameMatch (fund-name.ts) reported at the
  // time this entry was reviewed - a snapshot for a human re-reading this
  // file later, not re-validated live. The decision is keyed on the symbol
  // alone, not on this string staying identical to the classifier's current
  // output, so a later wording tweak to a pattern's label never invalidates
  // an already-reviewed decision.
  flagReason: string;
  decision: FundNameReviewDecision;
  rationale: string;
};

// The three-and-really-four-state outcome for one candidate, on a
// curation re-run:
//   - not-flagged: the classifier has nothing to say about this name;
//     no review was ever needed.
//   - reviewed-kept / reviewed-excluded: flagged, and a prior human
//     decision for this exact symbol already exists - apply it silently,
//     no re-prompt.
//   - needs-review: flagged, and no prior decision exists for this
//     symbol - the one state that must stop an automated run rather than
//     guess. A flagged name with no review record must never silently
//     end up in (or out of) a list that places real, if paper, trades.
export type FundNameReviewClassification =
  | { status: "not-flagged" }
  | { status: "reviewed-kept"; entry: FundNameReviewEntry }
  | { status: "reviewed-excluded"; entry: FundNameReviewEntry }
  | { status: "needs-review" };

export function classifyForReview(
  symbol: string,
  name: string,
  reviewedEntries: ReadonlyMap<string, FundNameReviewEntry>,
): FundNameReviewClassification {
  if (!isLikelyFundOrDerivativeName(name)) {
    return { status: "not-flagged" };
  }

  const entry = reviewedEntries.get(symbol);
  if (!entry) {
    return { status: "needs-review" };
  }

  return entry.decision === "kept"
    ? { status: "reviewed-kept", entry }
    : { status: "reviewed-excluded", entry };
}
