import { describe, expect, it } from "vitest";
import {
  isWorkerRunStale,
  STALE_THRESHOLD_MS_WHEN_CLOSED,
  STALE_THRESHOLD_MS_WHEN_OPEN,
} from "./worker-staleness";

describe("isWorkerRunStale", () => {
  it("is false just under the open-market threshold", () => {
    expect(isWorkerRunStale(STALE_THRESHOLD_MS_WHEN_OPEN - 1, true)).toBe(false);
  });

  it("is true just over the open-market threshold", () => {
    expect(isWorkerRunStale(STALE_THRESHOLD_MS_WHEN_OPEN + 1, true)).toBe(true);
  });

  it("is false just under the closed-market threshold", () => {
    expect(isWorkerRunStale(STALE_THRESHOLD_MS_WHEN_CLOSED - 1, false)).toBe(false);
  });

  it("is true just over the closed-market threshold", () => {
    expect(isWorkerRunStale(STALE_THRESHOLD_MS_WHEN_CLOSED + 1, false)).toBe(true);
  });

  // The whole point of having two thresholds: the same elapsed time reads
  // as abnormal while the market is open (nothing is watching a fillable
  // order) but perfectly normal while it's closed (there's nothing to
  // watch for yet).
  it("the same elapsed time can be stale when open but not when closed", () => {
    const elapsed = STALE_THRESHOLD_MS_WHEN_OPEN + 1;
    expect(isWorkerRunStale(elapsed, true)).toBe(true);
    expect(isWorkerRunStale(elapsed, false)).toBe(false);
  });
});
