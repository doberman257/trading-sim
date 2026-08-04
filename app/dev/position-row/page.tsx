import { PositionRow } from "@/components/PositionRow";

export default function PositionRowPreviewPage() {
  return (
    <main className="bg-base min-h-screen p-6">
      <p className="text-subtle mb-4 text-xs">
        Design preview only — not part of the dashboard. Demonstrates{" "}
        <code className="text-muted">PositionRow</code> in three states: profit, loss, and stale
        (market closed).
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
                    Avg cost ($)
                  </th>
                  <th className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase">
                    Price ($)
                  </th>
                  <th className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase">
                    Market value ($)
                  </th>
                  <th className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase">
                    Unrealized P&amp;L ($)
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* Profit */}
                <PositionRow
                  symbol="AAPL"
                  quantity={50}
                  avgCostCents={15000n}
                  currentPriceCents={17832n}
                />
                {/* Loss */}
                <PositionRow
                  symbol="TSLA"
                  quantity={20}
                  avgCostCents={25000n}
                  currentPriceCents={21015n}
                />
                {/* Stale - market closed, last-close price dimmed */}
                <PositionRow
                  symbol="MSFT"
                  quantity={15}
                  avgCostCents={30000n}
                  currentPriceCents={30550n}
                  isStale
                />
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
