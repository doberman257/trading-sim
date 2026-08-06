import { PositionCard } from "./PositionCard";
import { PositionRow } from "./PositionRow";
import type { PositionValuation } from "@/lib/trading/portfolio";

export type PositionsPanelProps = {
  positions: PositionValuation[];
  /** True when prices shown are from the last close rather than live - see MarketStatusBanner. */
  isStale: boolean;
};

export function PositionsPanel({ positions, isStale }: PositionsPanelProps) {
  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Positions</h2>
      </header>
      <div className="p-4">
        {positions.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">
            No positions yet — place your first trade to get started.
          </p>
        ) : (
          <>
            {/* Table at lg+, stacked cards below - see the trading-ui-design
                skill's Responsive tables pattern. */}
            <table className="hidden w-full text-sm lg:table">
              <thead>
                <tr className="border-default border-b">
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-left text-xs font-normal tracking-wide uppercase"
                  >
                    Symbol
                  </th>
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase"
                  >
                    Qty
                  </th>
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase"
                  >
                    Avg cost
                  </th>
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase"
                  >
                    Price
                  </th>
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase"
                  >
                    Market value
                  </th>
                  <th
                    scope="col"
                    className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase"
                  >
                    Unrealized P&amp;L
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <PositionRow
                    key={position.symbol}
                    symbol={position.symbol}
                    quantity={position.quantity}
                    avgCostCents={position.avgCostCents}
                    currentPriceCents={position.currentPriceCents}
                    marketValueCents={position.marketValueCents}
                    unrealizedPnlCents={position.unrealizedPnlCents}
                    unrealizedPnlPercent={position.unrealizedPnlPercent}
                    isStale={isStale}
                  />
                ))}
              </tbody>
            </table>

            <div className="flex flex-col gap-2 lg:hidden">
              {positions.map((position) => (
                <PositionCard
                  key={position.symbol}
                  symbol={position.symbol}
                  quantity={position.quantity}
                  avgCostCents={position.avgCostCents}
                  currentPriceCents={position.currentPriceCents}
                  marketValueCents={position.marketValueCents}
                  unrealizedPnlCents={position.unrealizedPnlCents}
                  unrealizedPnlPercent={position.unrealizedPnlPercent}
                  isStale={isStale}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
