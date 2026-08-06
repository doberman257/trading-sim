"use client";

import { useState, useTransition } from "react";
import { toggleWatchlist } from "@/app/actions/watchlist";

export type WatchlistStarProps = {
  symbol: string;
  initialWatched: boolean;
};

// Star color is --color-accent, not gain/loss/warn - this toggle carries no
// financial-direction or data-freshness meaning, and the trading-ui-design
// skill reserves gain/loss strictly for that. Accent (already used for
// focus rings and links) is the "this is selected/active" color the rest of
// the system otherwise has no use for.
export function WatchlistStar({ symbol, initialWatched }: WatchlistStarProps) {
  const [watched, setWatched] = useState(initialWatched);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    const next = !watched;
    setWatched(next);

    startTransition(async () => {
      try {
        const result = await toggleWatchlist(symbol);
        setWatched(result.watched);
      } catch {
        setWatched(!next);
      }
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      aria-pressed={watched}
      aria-label={watched ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`}
      className={`text-base leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        watched ? "text-accent" : "text-muted hover:text-fg"
      }`}
    >
      <span aria-hidden>{watched ? "★" : "☆"}</span>
    </button>
  );
}
