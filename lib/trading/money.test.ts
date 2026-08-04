import { describe, expect, it } from "vitest";
import { formatCents, multiply, toCents } from "./money";

describe("toCents", () => {
  it("parses a plain dollar amount", () => {
    expect(toCents("12.34")).toBe(1234n);
  });

  it("parses a whole dollar amount with no decimal part", () => {
    expect(toCents("12")).toBe(1200n);
  });

  it("pads a single decimal digit", () => {
    expect(toCents("12.3")).toBe(1230n);
  });

  it("parses negative amounts", () => {
    expect(toCents("-12.34")).toBe(-1234n);
  });

  it("parses negative whole amounts", () => {
    expect(toCents("-12")).toBe(-1200n);
  });

  it("rejects more than two decimal places", () => {
    expect(() => toCents("12.345")).toThrow();
  });

  it("rejects non-numeric input", () => {
    expect(() => toCents("abc")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => toCents("")).toThrow();
  });

  it("rejects a trailing decimal point with no digits", () => {
    expect(() => toCents("12.")).toThrow();
  });

  it("rejects a leading decimal point with no whole digits", () => {
    expect(() => toCents(".5")).toThrow();
  });

  it("rejects multiple signs", () => {
    expect(() => toCents("--12.34")).toThrow();
  });

  it("handles large values without precision loss", () => {
    expect(toCents("12345678901234.56")).toBe(1234567890123456n);
  });
});

describe("formatCents", () => {
  it("formats a plain amount", () => {
    expect(formatCents(1234n)).toBe("12.34");
  });

  it("pads single-digit cents", () => {
    expect(formatCents(1205n)).toBe("12.05");
  });

  it("formats amounts under a dollar", () => {
    expect(formatCents(5n)).toBe("0.05");
  });

  it("formats negative amounts", () => {
    expect(formatCents(-1234n)).toBe("-12.34");
  });

  it("formats negative amounts under a dollar", () => {
    expect(formatCents(-5n)).toBe("-0.05");
  });

  it("formats zero", () => {
    expect(formatCents(0n)).toBe("0.00");
  });

  it("round-trips through toCents", () => {
    expect(toCents(formatCents(987654321n))).toBe(987654321n);
  });
});

describe("multiply", () => {
  it("multiplies price by an integer quantity", () => {
    expect(multiply(1000n, 3)).toBe(3000n);
  });

  it("throws on a non-integer quantity", () => {
    expect(() => multiply(1000n, 1.5)).toThrow();
  });

  it("throws on a negative quantity", () => {
    expect(() => multiply(1000n, -1)).toThrow();
  });

  it("allows a zero quantity", () => {
    expect(multiply(1000n, 0)).toBe(0n);
  });
});

describe("float drift", () => {
  it("0.10 + 0.20 does not equal 0.30 as floats, but does as cents", () => {
    expect(0.1 + 0.2 === 0.3).toBe(false);
    expect(toCents("0.10") + toCents("0.20") === toCents("0.30")).toBe(true);
  });
});
