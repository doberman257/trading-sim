"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { searchStocks } from "@/app/actions/search";
import { SymbolSchema } from "@/lib/trading/symbol";
import type { AssetSearchResult } from "@/lib/db/assets";

const SEARCH_DEBOUNCE_MS = 250;

export function StockSearch() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<AssetSearchResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");
  const requestIdRef = useRef(0);

  const trimmed = input.trim();

  // Debounced, keyed off a request id - same pattern as OrderTicket's quote
  // refetch, for the same reason: a slow response for a query the user
  // already changed away from must never overwrite a newer one.
  useEffect(() => {
    if (trimmed.length === 0) {
      setResults([]);
      setStatus("idle");
      return;
    }

    const requestId = ++requestIdRef.current;
    setStatus("loading");

    const timer = setTimeout(() => {
      searchStocks(trimmed)
        .then((found) => {
          if (requestId !== requestIdRef.current) return;
          setResults(found);
          setStatus("done");
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setResults([]);
          setStatus("done");
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [trimmed]);

  // If the local list has nothing but the query looks like a real ticker,
  // that's most likely either a genuine symbol the asset sync hasn't caught
  // up on yet, or a delisted one - offer a direct link to the stock page
  // either way, which resolves the question against a live Alpaca quote
  // rather than leaving a dead end here.
  const looksLikeTicker = SymbolSchema.safeParse(trimmed).success;
  const showDirectLookup = status === "done" && results.length === 0 && looksLikeTicker;

  return (
    <div className="relative">
      <input
        value={input}
        onChange={(event) => setInput(event.target.value)}
        placeholder="Search by symbol or company name"
        autoComplete="off"
        className="border-default bg-elevated text-fg placeholder:text-subtle focus:border-strong focus:ring-accent w-full rounded-md border px-3 py-2 text-sm focus:ring-1 focus:outline-none"
      />

      {trimmed.length > 0 && (
        <div className="border-default bg-panel absolute z-10 mt-1 w-full rounded-md border shadow-none">
          {status === "loading" && results.length === 0 && (
            <p className="text-muted px-3 py-2 text-xs">Searching…</p>
          )}

          {results.map((result) => (
            <Link
              key={result.symbol}
              href={`/stock/${result.symbol}`}
              className="hover:bg-elevated flex items-center justify-between px-3 py-2 text-sm transition-colors"
            >
              <span className="flex items-center gap-2">
                <span className="text-fg font-medium">{result.symbol}</span>
                <span className="text-muted truncate">{result.name}</span>
              </span>
              <span className="text-subtle text-xs">{result.exchange}</span>
            </Link>
          ))}

          {status === "done" && results.length === 0 && !showDirectLookup && (
            <p className="text-muted px-3 py-2 text-xs">No matches in our stock list.</p>
          )}

          {showDirectLookup && (
            <Link
              href={`/stock/${trimmed.toUpperCase()}`}
              className="hover:bg-elevated flex items-center justify-between px-3 py-2 text-sm transition-colors"
            >
              <span className="text-fg">
                Not in our stock list — look up{" "}
                <span className="font-medium">{trimmed.toUpperCase()}</span> directly
              </span>
              <span className="text-subtle text-xs">via Alpaca</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
