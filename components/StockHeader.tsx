import { WatchlistStar } from "./WatchlistStar";

export type StockHeaderProps = {
  symbol: string;
  // Null when the symbol isn't in our local assets table yet - see
  // lib/db/assets.ts's getAssetBySymbol. Rendered with just the bare symbol
  // rather than inventing a name.
  name: string | null;
  exchange: string | null;
  initialWatched: boolean;
};

export function StockHeader({ symbol, name, exchange, initialWatched }: StockHeaderProps) {
  return (
    <div className="flex items-center gap-3">
      <WatchlistStar symbol={symbol} initialWatched={initialWatched} />
      <div>
        <h1 className="text-fg text-lg font-medium">
          {symbol}
          {name && <span className="text-muted ml-2 text-sm font-normal">{name}</span>}
        </h1>
        {exchange && <p className="text-subtle text-xs">{exchange}</p>}
      </div>
    </div>
  );
}
