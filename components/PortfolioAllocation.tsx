import type { AllocationSlice } from "@/lib/trading/allocation";
import { formatCents } from "@/lib/trading/money";

export type PortfolioAllocationProps = {
  slices: AllocationSlice[];
};

// A single decreasing-opacity scale of --color-accent for position slices,
// not a distinct hue per symbol - this project's token set has no
// categorical/qualitative palette (gain/loss/warn/accent each carry one
// fixed meaning; see the trading-ui-design skill), and inventing 5+ new
// arbitrary colors just for this chart's legend would be a bigger design-
// system change than "add a chart." Cash gets a visually distinct neutral
// treatment (muted, not accent) since it isn't an investment the way a held
// symbol is. Cycles via modulo past 5 positions, which is coarser than
// perfectly distinct but this app's own scale (a handful of positions) is
// exactly where this was scoped to work well.
const POSITION_COLOR_CLASSES = [
  "bg-accent",
  "bg-accent/75",
  "bg-accent/55",
  "bg-accent/40",
  "bg-accent/25",
];
const CASH_COLOR_CLASS = "bg-muted/50";

type ColoredSlice = AllocationSlice & { colorClassName: string };

function withColors(slices: AllocationSlice[]): ColoredSlice[] {
  let positionIndex = -1;
  return slices.map((slice) => {
    if (slice.kind === "position") positionIndex += 1;
    const colorClassName =
      slice.kind === "cash"
        ? CASH_COLOR_CLASS
        : POSITION_COLOR_CLASSES[positionIndex % POSITION_COLOR_CLASSES.length]!;
    return { ...slice, colorClassName };
  });
}

export function PortfolioAllocation({ slices }: PortfolioAllocationProps) {
  const coloredSlices = withColors(slices.filter((slice) => slice.valueCents > 0n));

  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Allocation</h2>
      </header>
      <div className="p-4">
        {coloredSlices.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">Nothing to allocate yet.</p>
        ) : (
          <>
            <div className="border-default bg-elevated flex h-2.5 overflow-hidden rounded-full border">
              {coloredSlices.map((slice) => (
                <div
                  key={slice.label}
                  className={slice.colorClassName}
                  style={{ width: `${slice.percent}%` }}
                  title={`${slice.label}: $${formatCents(slice.valueCents)} (${slice.percent.toFixed(1)}%)`}
                />
              ))}
            </div>

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
              {coloredSlices.map((slice) => (
                <div key={slice.label} className="flex items-center gap-1.5 text-xs">
                  <span aria-hidden className={`size-2 rounded-full ${slice.colorClassName}`} />
                  <span className="text-fg font-medium">{slice.label}</span>
                  <span className="text-muted font-mono tabular-nums">
                    ${formatCents(slice.valueCents)}
                  </span>
                  <span className="text-subtle font-mono tabular-nums">
                    ({slice.percent.toFixed(1)}%)
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
