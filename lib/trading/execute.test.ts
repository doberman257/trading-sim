import { describe, expect, it } from "vitest";
import { executeMarketOrder } from "./execute";
import { toCents } from "./money";
import type { AccountState, Position, Quote } from "./types";

// Wed Jun 10 2026, 11:00am ET (EDT, UTC-4) - safely inside regular market
// hours, so every other test in this file can assume the market is open
// without that being what's under test.
const NOW = new Date("2026-06-10T15:00:00.000Z");

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "AAPL",
    bidCents: toCents("99.00"),
    askCents: toCents("100.00"),
    timestamp: NOW,
    ...overrides,
  };
}

function makeAccount(
  cashCents: bigint,
  positions: ReadonlyMap<string, Position> = new Map(),
): AccountState {
  return { cashCents, positions };
}

describe("executeMarketOrder", () => {
  it("fills a buy at the ask, not the bid", () => {
    const account = makeAccount(toCents("1000.00"));
    const quote = makeQuote();

    const result = executeMarketOrder(account, quote, "buy", 1, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fill.priceCents).toBe(quote.askCents);
    }
  });

  it("fills a sell at the bid, not the ask", () => {
    const positions = new Map([["AAPL", { quantity: 5, avgCostCents: toCents("90.00") }]]);
    const account = makeAccount(0n, positions);
    const quote = makeQuote();

    const result = executeMarketOrder(account, quote, "sell", 1, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fill.priceCents).toBe(quote.bidCents);
    }
  });

  it("rejects a buy with insufficient funds", () => {
    const account = makeAccount(toCents("50.00"));
    const quote = makeQuote();

    const result = executeMarketOrder(account, quote, "buy", 1, NOW);

    expect(result).toEqual({ ok: false, reason: "insufficient_funds" });
  });

  it("accepts a buy with exactly sufficient funds and leaves 0 cash", () => {
    const quote = makeQuote();
    const account = makeAccount(quote.askCents * 2n);

    const result = executeMarketOrder(account, quote, "buy", 2, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fill.newCashCents).toBe(0n);
    }
  });

  it("rejects selling a position you don't hold", () => {
    const account = makeAccount(toCents("1000.00"));
    const quote = makeQuote();

    const result = executeMarketOrder(account, quote, "sell", 1, NOW);

    expect(result).toEqual({ ok: false, reason: "insufficient_shares" });
  });

  it("rejects selling more shares than you hold", () => {
    const positions = new Map([["AAPL", { quantity: 2, avgCostCents: toCents("90.00") }]]);
    const account = makeAccount(0n, positions);
    const quote = makeQuote();

    const result = executeMarketOrder(account, quote, "sell", 3, NOW);

    expect(result).toEqual({ ok: false, reason: "insufficient_shares" });
  });

  it("averages cost as (2 @ $100) then (2 @ $200) to $150", () => {
    const account = makeAccount(toCents("100000.00"));

    const firstBuy = executeMarketOrder(
      account,
      makeQuote({ askCents: toCents("100.00") }),
      "buy",
      2,
      NOW,
    );
    expect(firstBuy.ok).toBe(true);
    if (!firstBuy.ok || !firstBuy.fill.newPosition) return;

    const accountAfterFirstBuy = makeAccount(
      firstBuy.fill.newCashCents,
      new Map([["AAPL", firstBuy.fill.newPosition]]),
    );

    const secondBuy = executeMarketOrder(
      accountAfterFirstBuy,
      makeQuote({ askCents: toCents("200.00") }),
      "buy",
      2,
      NOW,
    );
    expect(secondBuy.ok).toBe(true);
    if (!secondBuy.ok) return;

    expect(secondBuy.fill.newPosition?.avgCostCents).toBe(toCents("150.00"));
  });

  it("leaves average cost unchanged after a sell", () => {
    const avgCostCents = toCents("90.00");
    const positions = new Map([["AAPL", { quantity: 5, avgCostCents }]]);
    const account = makeAccount(0n, positions);
    const quote = makeQuote();

    const result = executeMarketOrder(account, quote, "sell", 2, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fill.newPosition?.avgCostCents).toBe(avgCostCents);
    }
  });

  it("computes realized P&L: bought at $190, sold 2 @ $199 gives +$18", () => {
    const positions = new Map([["AAPL", { quantity: 5, avgCostCents: toCents("190.00") }]]);
    const account = makeAccount(0n, positions);
    const quote = makeQuote({ bidCents: toCents("199.00") });

    const result = executeMarketOrder(account, quote, "sell", 2, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fill.realizedPnlCents).toBe(toCents("18.00"));
    }
  });

  it("sets newPosition to null when selling the full position", () => {
    const positions = new Map([["AAPL", { quantity: 3, avgCostCents: toCents("90.00") }]]);
    const account = makeAccount(0n, positions);
    const quote = makeQuote();

    const result = executeMarketOrder(account, quote, "sell", 3, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fill.newPosition).toBeNull();
    }
  });

  it("rejects a zero quantity order", () => {
    const account = makeAccount(toCents("1000.00"));
    const quote = makeQuote();

    const result = executeMarketOrder(account, quote, "buy", 0, NOW);

    expect(result).toEqual({ ok: false, reason: "invalid_quantity" });
  });

  it("rejects a negative quantity order", () => {
    const account = makeAccount(toCents("1000.00"));
    const quote = makeQuote();

    const result = executeMarketOrder(account, quote, "buy", -1, NOW);

    expect(result).toEqual({ ok: false, reason: "invalid_quantity" });
  });

  it("rejects a buy when the market is closed", () => {
    const account = makeAccount(toCents("1000.00"));
    // Sat Jun 13 2026, 10:00am ET (EDT) - a weekend, market closed.
    const closedNow = new Date("2026-06-13T14:00:00.000Z");
    const quote = makeQuote({ timestamp: closedNow });

    const result = executeMarketOrder(account, quote, "buy", 1, closedNow);

    expect(result).toEqual({ ok: false, reason: "market_closed" });
  });

  it("rejects a sell when the market is closed", () => {
    const positions = new Map([["AAPL", { quantity: 5, avgCostCents: toCents("90.00") }]]);
    const account = makeAccount(0n, positions);
    // Sat Jun 13 2026, 10:00am ET (EDT) - a weekend, market closed.
    const closedNow = new Date("2026-06-13T14:00:00.000Z");
    const quote = makeQuote({ timestamp: closedNow });

    const result = executeMarketOrder(account, quote, "sell", 1, closedNow);

    expect(result).toEqual({ ok: false, reason: "market_closed" });
  });

  it("rejects a quote older than 60 seconds", () => {
    const account = makeAccount(toCents("1000.00"));
    const quote = makeQuote({ timestamp: new Date(NOW.getTime() - 61_000) });

    const result = executeMarketOrder(account, quote, "buy", 1, NOW);

    expect(result).toEqual({ ok: false, reason: "stale_quote" });
  });

  it("accepts a quote exactly at the 60 second boundary", () => {
    const account = makeAccount(toCents("1000.00"));
    const quote = makeQuote({ timestamp: new Date(NOW.getTime() - 60_000) });

    const result = executeMarketOrder(account, quote, "buy", 1, NOW);

    expect(result.ok).toBe(true);
  });
});
