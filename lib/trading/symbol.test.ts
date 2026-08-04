import { describe, expect, it } from "vitest";
import { SymbolSchema } from "./symbol";

describe("SymbolSchema", () => {
  it("uppercases lowercase input", () => {
    expect(SymbolSchema.parse("aapl")).toBe("AAPL");
  });

  it("trims surrounding whitespace and uppercases", () => {
    expect(SymbolSchema.parse(" tsla ")).toBe("TSLA");
  });

  it("rejects an empty string", () => {
    expect(SymbolSchema.safeParse("").success).toBe(false);
  });

  it("rejects a string longer than 5 letters", () => {
    expect(SymbolSchema.safeParse("TOOLONG").success).toBe(false);
  });

  it("rejects a symbol containing a digit", () => {
    expect(SymbolSchema.safeParse("AA1").success).toBe(false);
  });

  it("rejects a symbol containing punctuation", () => {
    expect(SymbolSchema.safeParse("AA.B").success).toBe(false);
    expect(SymbolSchema.safeParse("AA-B").success).toBe(false);
  });

  it("accepts a single letter", () => {
    expect(SymbolSchema.parse("a")).toBe("A");
  });

  it("accepts exactly 5 letters", () => {
    expect(SymbolSchema.parse("abcde")).toBe("ABCDE");
  });

  it("rejects whitespace-only input", () => {
    expect(SymbolSchema.safeParse("   ").success).toBe(false);
  });
});
