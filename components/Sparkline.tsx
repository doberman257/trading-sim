import { buildSparklineGeometry } from "./sparklineMath";

export type SparklineProps = {
  /** Daily closes, oldest first - same ordering fetchDailyBarsForSymbols returns. */
  closesCents: readonly bigint[];
  width?: number;
  height?: number;
};

const DIRECTION_CLASS_NAME = {
  up: "text-gain",
  down: "text-loss",
  flat: "text-muted",
} as const;

const DIRECTION_LABEL = {
  up: "trending up",
  down: "trending down",
  flat: "flat",
} as const;

// A plain server-renderable SVG polyline, not a lightweight-charts instance
// - a row of 20 watchlist entries would mean 20 full chart instances for
// what's meant to be a glance-sized shape, and this needs neither axes,
// crosshairs, nor interactivity. Color comes from `currentColor` plus a
// `text-*` token, not a `stroke-*` utility, since this project's Tailwind
// setup is only confirmed to generate bg-*/text-*/border-*/ring-* from the
// theme's --color-* tokens (see the trading-ui-design skill) - stroke was
// never verified, so this sidesteps the question entirely.
export function Sparkline({ closesCents, width = 64, height = 24 }: SparklineProps) {
  const geometry = buildSparklineGeometry(closesCents, width, height);

  if (!geometry) {
    return <span className="text-subtle text-xs">—</span>;
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`30-day price trend: ${DIRECTION_LABEL[geometry.direction]}`}
      className={DIRECTION_CLASS_NAME[geometry.direction]}
    >
      <polyline
        points={geometry.points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
