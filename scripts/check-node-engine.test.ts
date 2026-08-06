import { describe, expect, it } from "vitest";
import { checkEvenLtsMajor } from "./check-node-engine";

describe("checkEvenLtsMajor", () => {
  it("accepts an even major expressed as a semver range", () => {
    expect(checkEvenLtsMajor("24.x")).toBeNull();
  });

  it("accepts an even major expressed as an exact version", () => {
    expect(checkEvenLtsMajor("22.0.0")).toBeNull();
  });

  it("accepts a bare even major number", () => {
    expect(checkEvenLtsMajor("20")).toBeNull();
  });

  it("rejects an odd major - the exact case that broke a real deploy", () => {
    const error = checkEvenLtsMajor("25.6.1");
    expect(error).toContain("25");
    expect(error).toContain("odd-numbered");
  });

  it("rejects an odd major expressed as a range", () => {
    expect(checkEvenLtsMajor("21.x")).not.toBeNull();
  });

  it("reports a clear error when engines.node is missing entirely", () => {
    expect(checkEvenLtsMajor(undefined)).toContain("missing engines.node");
  });

  it("reports a clear error when the version string has no parseable number", () => {
    expect(checkEvenLtsMajor("latest")).toContain("Could not parse");
  });
});
