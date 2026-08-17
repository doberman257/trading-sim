import { describe, expect, it } from "vitest";
import { classifyForReview, type FundNameReviewEntry } from "./fund-name-review";

function reviewMap(entries: FundNameReviewEntry[]): Map<string, FundNameReviewEntry> {
  return new Map(entries.map((entry) => [entry.symbol, entry]));
}

describe("classifyForReview", () => {
  it("passes through a name the classifier never flagged, with no review lookup needed", () => {
    const result = classifyForReview("AAPL", "Apple Inc.", reviewMap([]));
    expect(result).toEqual({ status: "not-flagged" });
  });

  it("silently includes a flagged symbol already reviewed and kept", () => {
    const entry: FundNameReviewEntry = {
      symbol: "NTRS",
      flagReason: "Trust wording",
      decision: "kept",
      rationale: "Northern Trust Corporation - a real bank/asset manager, not a trust vehicle.",
    };
    const result = classifyForReview("NTRS", "Northern Trust Corporation", reviewMap([entry]));
    expect(result).toEqual({ status: "reviewed-kept", entry });
  });

  it("silently drops a flagged symbol already reviewed and excluded", () => {
    const entry: FundNameReviewEntry = {
      symbol: "FAKE",
      flagReason: "ETF wording",
      decision: "excluded",
      rationale: "A genuine fund that happened to be an index constituent by mistake in this test.",
    };
    const result = classifyForReview("FAKE", "Fake Leveraged ETF", reviewMap([entry]));
    expect(result).toEqual({ status: "reviewed-excluded", entry });
  });

  // The one case that must halt an automated run rather than guess - see
  // the type's own comment in fund-name-review.ts.
  it("flags a novel name the classifier caught but no review entry covers, rather than defaulting either way", () => {
    const result = classifyForReview(
      "NEWCO",
      "Newco Investment Trust",
      reviewMap([
        {
          symbol: "SOMEOTHER",
          flagReason: "Trust wording",
          decision: "kept",
          rationale: "Unrelated entry - present to prove the lookup is keyed by symbol.",
        },
      ]),
    );
    expect(result).toEqual({ status: "needs-review" });
  });
});
