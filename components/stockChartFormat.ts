import { isBusinessDay, type Time } from "lightweight-charts";

// Kept in its own file, separate from StockChart.tsx: that component calls
// createChart, which touches the DOM - pulling it into the default unit
// suite (which runs under Vitest's "node" environment, no DOM) would risk
// breaking on import alone. This file only imports the small type-guard
// isBusinessDay and a type, so the actual logic here stays testable without
// a browser, same reasoning as orderMessages.ts staying DB-free.

export function centsToDollars(cents: string): number {
  return Number(BigInt(cents)) / 100;
}

export function formatDollars(cents: string): string {
  return centsToDollars(cents).toFixed(2);
}

// Appends an alpha channel to a 6-digit hex color - a canvas library needing
// a literal color string is a legitimate exception to "semantic tokens
// only," but that exception doesn't extend to inventing a new shade; this
// only ever dims a token already read from globals.css.
export function withAlpha(hex: string, alphaHex: string): string {
  return `${hex}${alphaHex}`;
}

// The library accepts a "YYYY-MM-DD" string as Time when data is set, but
// there's no guarantee it hands the same string back from a crosshair-move
// event - internally it may normalize to a BusinessDay object instead. Using
// isBusinessDay (exported by the library itself, not a hand-rolled guess at
// its internal representation) to reconstruct the same "YYYY-MM-DD" form
// either way is what makes a crosshair-driven lookup reliable regardless of
// which shape actually comes back.
export function timeToDateKey(time: Time): string | undefined {
  if (typeof time === "string") return time;
  if (isBusinessDay(time)) {
    return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
  }
  return undefined;
}

// True when a bar's own close is at or above its own open - used to color
// both the candle and its volume bar the same direction. Compared as
// BigInt, not string >=: "10050" >= "9999" is false lexicographically (a
// real bug caught during development) even though 10050 is numerically
// larger - exactly the trap string-compared cents values fall into whenever
// open and close land on different digit counts.
export function isUpBar(openCents: string, closeCents: string): boolean {
  return BigInt(closeCents) >= BigInt(openCents);
}
