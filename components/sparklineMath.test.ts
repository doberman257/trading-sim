import { describe, expect, it } from "vitest";
import { buildSparklineGeometry } from "./sparklineMath";

describe("buildSparklineGeometry", () => {
  it("returns null for zero points", () => {
    expect(buildSparklineGeometry([], 80, 24)).toBeNull();
  });

  it("returns null for a single point - no shape, no direction", () => {
    expect(buildSparklineGeometry([10000n], 80, 24)).toBeNull();
  });

  it("reports 'up' when the last close is above the first", () => {
    const geometry = buildSparklineGeometry([10000n, 10500n, 11000n], 80, 24);
    expect(geometry?.direction).toBe("up");
  });

  it("reports 'down' when the last close is below the first", () => {
    const geometry = buildSparklineGeometry([11000n, 10500n, 10000n], 80, 24);
    expect(geometry?.direction).toBe("down");
  });

  it("reports 'flat' when the last close equals the first, even if it moved in between", () => {
    const geometry = buildSparklineGeometry([10000n, 12000n, 8000n, 10000n], 80, 24);
    expect(geometry?.direction).toBe("flat");
  });

  it("places the first and last points at the left and right edges", () => {
    const geometry = buildSparklineGeometry([10000n, 10500n, 11000n], 80, 24);
    const points = geometry!.points.split(" ");
    expect(points[0]).toBe("0.0,24.0");
    expect(points[2]).toBe("80.0,0.0");
  });

  it("draws a flat horizontal line through the middle when every value is equal", () => {
    const geometry = buildSparklineGeometry([10000n, 10000n, 10000n], 80, 24);
    const points = geometry!.points.split(" ");
    expect(points).toEqual(["0.0,12.0", "40.0,12.0", "80.0,12.0"]);
  });

  it("compares numerically across a digit-count boundary", () => {
    // Guards against the class of bug fixed in isUpBar (stockChartFormat.ts):
    // 9999 -> 10050 is a real increase, and closesCents must never be
    // compared as strings ("9999" >= "10050" is true lexicographically).
    const geometry = buildSparklineGeometry([9999n, 10050n], 80, 24);
    expect(geometry?.direction).toBe("up");
  });
});
