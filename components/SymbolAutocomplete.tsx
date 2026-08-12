"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { searchStocks } from "@/app/actions/search";
import { SymbolSchema } from "@/lib/trading/symbol";
import type { AssetSearchResult } from "@/lib/db/assets";

const SEARCH_DEBOUNCE_MS = 250;

export type SymbolAutocompleteProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSelect: (symbol: string) => void;
  disabled?: boolean;
  placeholder?: string;
  inputClassName: string;
};

// The same DB-backed search /discover uses (searchStocks -> searchAssets'
// ILIKE query against the assets table) - no second search implementation.
// What differs is what happens on a match: StockSearch.tsx navigates to
// /stock/[symbol] on click, since it's a browsing tool; this is a form
// field, so selecting a result fills the field and keeps the user in the
// order ticket. That difference in what "choosing a result" means is
// exactly why this is its own component rather than a reused
// StockSearch - the underlying data source is shared, the interaction
// isn't.
export function SymbolAutocomplete({
  value,
  onValueChange,
  onSelect,
  disabled,
  placeholder,
  inputClassName,
}: SymbolAutocompleteProps) {
  const [results, setResults] = useState<AssetSearchResult[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const requestIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);

  const trimmed = value.trim();

  // Debounced, keyed off a request id - same pattern as OrderTicket's own
  // quote refetch and StockSearch's own search, for the same reason: a
  // slow response for a query the user already changed away from must
  // never overwrite a newer one.
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
          setHighlightedIndex(-1);
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setResults([]);
          setStatus("done");
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [trimmed]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  // Keeps the highlighted row visible once the list is scrollable (see the
  // capped max-height below) - without this, arrowing down past the
  // visible rows would move the highlight somewhere the user can't see it,
  // which defeats the point of a keyboard-navigable list.
  useEffect(() => {
    if (highlightedIndex < 0) return;
    listboxRef.current
      ?.querySelector(`[data-index="${highlightedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  // Same escape hatch StockSearch.tsx offers: a query with no local match
  // that's still shaped like a real ticker is most likely a genuine symbol
  // the asset sync hasn't caught up on, or a delisted one - either way,
  // this app never gates trading on the local table (see lib/db/assets.ts),
  // so selecting this option just uses the typed symbol directly rather
  // than leaving a dead end.
  const looksLikeTicker = SymbolSchema.safeParse(trimmed).success;
  const showDirectOption = status === "done" && results.length === 0 && looksLikeTicker;
  const optionCount = results.length + (showDirectOption ? 1 : 0);

  function commitSelection(index: number) {
    if (index < 0 || index >= optionCount) return;
    const symbol = index < results.length ? results[index]!.symbol : trimmed.toUpperCase();
    onSelect(symbol);
    setIsOpen(false);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!isOpen || optionCount === 0) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlightedIndex((current) => (current + 1) % optionCount);
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlightedIndex((current) => (current - 1 + optionCount) % optionCount);
        break;
      case "Enter":
        // Only intercepted (and the form submit it would otherwise trigger
        // prevented) when a result is actually highlighted - typing an
        // exact symbol and pressing Enter with nothing highlighted still
        // submits the order form normally, same as before this component
        // existed.
        if (highlightedIndex >= 0) {
          event.preventDefault();
          commitSelection(highlightedIndex);
        }
        break;
      case "Escape":
        setIsOpen(false);
        setHighlightedIndex(-1);
        break;
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value.toUpperCase());
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        maxLength={5}
        autoComplete="off"
        disabled={disabled}
        role="combobox"
        aria-expanded={isOpen}
        aria-autocomplete="list"
        aria-controls="symbol-autocomplete-listbox"
        className={inputClassName}
      />

      {isOpen && trimmed.length > 0 && (
        <div
          ref={listboxRef}
          id="symbol-autocomplete-listbox"
          role="listbox"
          // Capped and internally scrollable - up to 20 results otherwise
          // grow the dropdown tall enough to overlap whatever's below it on
          // the page (confirmed for real: it covered the Positions table
          // and the pending-orders staleness banner on the dashboard).
          // max-h-72 is roughly 7-8 rows at this row height - enough to
          // orient in, not so many it reaches past the ticket itself.
          className="border-default bg-panel absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border shadow-none"
        >
          {status === "loading" && results.length === 0 && (
            <p className="text-muted px-3 py-2 text-xs">Searching…</p>
          )}

          {results.map((result, index) => (
            <button
              key={result.symbol}
              type="button"
              role="option"
              data-index={index}
              aria-selected={index === highlightedIndex}
              // Keeps focus (and the caret) in the input - a plain button
              // click would otherwise blur the input before onClick fires.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commitSelection(index)}
              onMouseEnter={() => setHighlightedIndex(index)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                index === highlightedIndex ? "bg-selected" : "hover:bg-elevated"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="text-fg font-medium">{result.symbol}</span>
                <span className="text-muted truncate">{result.name}</span>
              </span>
              <span className="text-subtle text-xs">{result.exchange}</span>
            </button>
          ))}

          {status === "done" && results.length === 0 && !showDirectOption && (
            <p className="text-muted px-3 py-2 text-xs">No matches in our stock list.</p>
          )}

          {showDirectOption && (
            <button
              type="button"
              role="option"
              data-index={results.length}
              aria-selected={results.length === highlightedIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commitSelection(results.length)}
              onMouseEnter={() => setHighlightedIndex(results.length)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                results.length === highlightedIndex ? "bg-selected" : "hover:bg-elevated"
              }`}
            >
              <span className="text-fg">
                Not in our stock list — use{" "}
                <span className="font-medium">{trimmed.toUpperCase()}</span> directly
              </span>
              <span className="text-subtle text-xs">via Alpaca</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
