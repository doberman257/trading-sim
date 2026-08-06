import { PopularStockCard } from "./PopularStockCard";
import { PopularStockRow } from "./PopularStockRow";

export type PopularStockItem = {
  symbol: string;
  name: string;
  bidCents: bigint | null;
  askCents: bigint | null;
};

export type PopularStocksPanelProps = {
  items: PopularStockItem[];
};

export function PopularStocksPanel({ items }: PopularStocksPanelProps) {
  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Popular</h2>
      </header>
      <div className="p-4">
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
                className="text-muted px-3 py-2 text-left text-xs font-normal tracking-wide uppercase"
              >
                Name
              </th>
              <th
                scope="col"
                className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase"
              >
                Bid
              </th>
              <th
                scope="col"
                className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase"
              >
                Ask
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <PopularStockRow key={item.symbol} {...item} />
            ))}
          </tbody>
        </table>

        <div className="flex flex-col gap-2 lg:hidden">
          {items.map((item) => (
            <PopularStockCard key={item.symbol} {...item} />
          ))}
        </div>
      </div>
    </section>
  );
}
