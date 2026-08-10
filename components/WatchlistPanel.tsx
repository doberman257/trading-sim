import { WatchlistCard } from "./WatchlistCard";
import { WatchlistRow } from "./WatchlistRow";
import type { WatchlistRowProps } from "./WatchlistRow";

export type WatchlistPanelProps = {
  items: WatchlistRowProps[];
};

export function WatchlistPanel({ items }: WatchlistPanelProps) {
  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Watchlist</h2>
      </header>
      <div className="p-4">
        <table className="hidden w-full text-sm lg:table">
          <thead>
            <tr className="border-default border-b">
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">Watched</span>
              </th>
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
              <th
                scope="col"
                className="text-muted px-3 py-2 text-left text-xs font-normal tracking-wide uppercase"
              >
                30d trend
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <WatchlistRow key={item.symbol} {...item} />
            ))}
          </tbody>
        </table>

        <div className="flex flex-col gap-2 lg:hidden">
          {items.map((item) => (
            <WatchlistCard key={item.symbol} {...item} />
          ))}
        </div>
      </div>
    </section>
  );
}
