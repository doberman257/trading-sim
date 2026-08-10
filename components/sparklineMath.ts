// Kept in its own plain file, no React import - same reasoning as
// stockChartFormat.ts and orderMessages.ts: the geometry math is pure and
// worth testing directly, without needing a render setup this project
// doesn't have.

export type SparklineDirection = "up" | "down" | "flat";

export type SparklineGeometry = {
  /** SVG <polyline> points attribute value. */
  points: string;
  direction: SparklineDirection;
};

// Null when there's too little data to draw a meaningful line - a single
// point (or none) has no shape and no direction.
export function buildSparklineGeometry(
  closesCents: readonly bigint[],
  width: number,
  height: number,
): SparklineGeometry | null {
  if (closesCents.length < 2) {
    return null;
  }

  const values = closesCents.map(Number);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      // Flat series (range === 0) draw a straight line through the middle
      // rather than dividing by zero.
      const y = range === 0 ? height / 2 : height - ((value - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const first = values[0]!;
  const last = values[values.length - 1]!;
  const direction: SparklineDirection = last > first ? "up" : last < first ? "down" : "flat";

  return { points, direction };
}
