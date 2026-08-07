import { notFound } from "next/navigation";
import { PositionRow } from "@/components/PositionRow";
import { toCents } from "@/lib/trading/money";
import { valuePosition } from "@/lib/trading/pnl";

function fixture(avgCostCents: bigint, currentPriceCents: bigint, quantity: number) {
  return {
    avgCostCents,
    currentPriceCents,
    quantity,
    ...valuePosition(avgCostCents, currentPriceCents, quantity),
  };
}

const profit = fixture(toCents("150.00"), toCents("178.32"), 50);
const loss = fixture(toCents("250.00"), toCents("210.15"), 20);
const stale = fixture(toCents("300.00"), toCents("305.50"), 15);

const upSparkline = [15000n, 15500n, 16200n, 17832n];
const downSparkline = [25000n, 23800n, 22000n, 21015n];
const flatSparkline = [30500n, 30800n, 30200n, 30550n];

// Design preview only - meaningless once deployed. Not gated with an
// authenticated allowlist or a secret because there's a simpler test that
// already covers it: NODE_ENV is "development" locally and "production"
// for both Vercel Preview and Production builds (Next.js sets it for any
// `next build`, not just true production), so this is unreachable on any
// deployed instance, not just prod, without needing a second gate.
export default function PositionRowPreviewPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }

  return (
    <main className="bg-base min-h-screen p-6">
      <p className="text-subtle mb-4 text-xs">
        Design preview only — not part of the dashboard. Demonstrates{" "}
        <code className="text-muted">PositionRow</code> in four states: profit, loss, stale (market
        closed), and price unavailable.
      </p>

      <div className="mx-auto max-w-3xl">
        <div className="border-warn/30 bg-warn/5 text-warn mb-3 flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <span className="bg-warn size-1.5 rounded-full" />
          Market closed — prices shown are from the last close. Opens Monday 9:30 AM ET.
        </div>

        <section className="border-default bg-panel rounded-lg border">
          <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-fg text-sm font-medium">Positions</h2>
          </header>
          <div className="p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-default border-b">
                  <th className="text-muted px-3 py-2 text-left text-xs font-normal tracking-wide uppercase">
                    Symbol
                  </th>
                  <th className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase">
                    Qty
                  </th>
                  <th className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase">
                    Avg cost
                  </th>
                  <th className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase">
                    Price
                  </th>
                  <th className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase">
                    Market value
                  </th>
                  <th className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase">
                    Unrealized P&amp;L
                  </th>
                  <th className="text-muted px-3 py-2 text-left text-xs font-normal tracking-wide uppercase">
                    30d trend
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* Profit */}
                <PositionRow symbol="AAPL" {...profit} sparklineCloses={upSparkline} />
                {/* Loss */}
                <PositionRow symbol="TSLA" {...loss} sparklineCloses={downSparkline} />
                {/* Stale - market closed, last-close price dimmed */}
                <PositionRow symbol="MSFT" {...stale} isStale sparklineCloses={flatSparkline} />
                {/* Price unavailable - distinct from stale: no number at all, not even a dimmed one */}
                <PositionRow
                  symbol="GOOG"
                  quantity={8}
                  avgCostCents={toCents("135.00")}
                  currentPriceCents={null}
                  marketValueCents={null}
                  unrealizedPnlCents={null}
                  unrealizedPnlPercent={null}
                  sparklineCloses={[]}
                />
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
