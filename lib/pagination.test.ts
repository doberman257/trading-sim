import { describe, expect, it } from "vitest";
import { clampPage, getPageCount, paginate } from "./pagination";

describe("getPageCount", () => {
  it("rounds up when items don't divide evenly into a page", () => {
    expect(getPageCount(21, 10)).toBe(3);
  });

  it("is exactly 1 for an empty list, never 0", () => {
    expect(getPageCount(0, 10)).toBe(1);
  });

  it("divides evenly when items are an exact multiple of the page size", () => {
    expect(getPageCount(20, 10)).toBe(2);
  });
});

describe("clampPage", () => {
  it("pulls a too-high page number back to the last real page", () => {
    expect(clampPage(99, 3)).toBe(3);
  });

  it("pulls a too-low page number up to page 1", () => {
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(-5, 3)).toBe(1);
  });

  it("leaves an in-range page number unchanged", () => {
    expect(clampPage(2, 3)).toBe(2);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 25 }, (_, i) => i + 1);

  it("returns the first pageSize items on page 1", () => {
    expect(paginate(items, 1, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("returns the next slice on page 2", () => {
    expect(paginate(items, 2, 10)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("returns a short final page instead of padding it", () => {
    expect(paginate(items, 3, 10)).toEqual([21, 22, 23, 24, 25]);
  });

  it("clamps an out-of-range page instead of returning an empty slice", () => {
    expect(paginate(items, 999, 10)).toEqual([21, 22, 23, 24, 25]);
  });

  it("returns everything on page 1 when there's only one page", () => {
    expect(paginate([1, 2, 3], 1, 10)).toEqual([1, 2, 3]);
  });
});
