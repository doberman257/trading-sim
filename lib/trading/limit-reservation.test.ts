import { describe, expect, it } from "vitest";
import { canPlaceLimitOrder, reservedCashCents, reservedShares } from "./limit-reservation";
import { toCents } from "./money";
import type { AccountState } from "./types";

function account(
  cashCents: bigint,
  positions: Record<string, { quantity: number; avgCostCents: bigint }> = {},
) {
  return {
    cashCents,
    positions: new Map(Object.entries(positions)),
  } satisfies AccountState;
}

describe("reservedCashCents", () => {
  it("sums quantity times each order's own limit price", () => {
    const reserved = reservedCashCents([
      { side: "buy", symbol: "AAPL", quantity: 10, limitPriceCents: toCents("100.00") },
      { side: "buy", symbol: "TSLA", quantity: 5, limitPriceCents: toCents("200.00") },
    ]);
    expect(reserved).toBe(toCents("2000.00"));
  });

  it("is zero with no pending orders", () => {
    expect(reservedCashCents([])).toBe(0n);
  });
});

describe("reservedShares", () => {
  it("sums quantity across orders", () => {
    expect(
      reservedShares([
        { side: "sell", symbol: "AAPL", quantity: 3, limitPriceCents: toCents("100.00") },
        { side: "sell", symbol: "AAPL", quantity: 4, limitPriceCents: toCents("110.00") },
      ]),
    ).toBe(7);
  });
});

describe("canPlaceLimitOrder", () => {
  it("accepts a buy that fits within available cash", () => {
    const result = canPlaceLimitOrder(
      account(toCents("1000.00")),
      { side: "buy", symbol: "AAPL", quantity: 5, limitPriceCents: toCents("100.00") },
      [],
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a buy that exceeds cash after accounting for other pending buys", () => {
    // $1000 cash, an existing pending buy already claims $900 of it
    // (10 shares * $90) - a new $200 order (2 * $100) has only $100 left
    // to work with and must be rejected.
    const result = canPlaceLimitOrder(
      account(toCents("1000.00")),
      { side: "buy", symbol: "TSLA", quantity: 2, limitPriceCents: toCents("100.00") },
      [{ side: "buy", symbol: "AAPL", quantity: 10, limitPriceCents: toCents("90.00") }],
    );
    expect(result).toEqual({ ok: false, reason: "insufficient_funds" });
  });

  it("accepts a buy right at the exact available boundary", () => {
    // $1000 cash, $900 reserved by another pending buy - exactly $100
    // left, and this order costs exactly $100.
    const result = canPlaceLimitOrder(
      account(toCents("1000.00")),
      { side: "buy", symbol: "TSLA", quantity: 1, limitPriceCents: toCents("100.00") },
      [{ side: "buy", symbol: "AAPL", quantity: 10, limitPriceCents: toCents("90.00") }],
    );
    expect(result).toEqual({ ok: true });
  });

  it("ignores other pending SELL orders when checking a buy's cash", () => {
    // A pending sell reserves shares, not cash - it must not reduce
    // available cash for an unrelated buy.
    const result = canPlaceLimitOrder(
      account(toCents("1000.00"), { AAPL: { quantity: 10, avgCostCents: toCents("50.00") } }),
      { side: "buy", symbol: "TSLA", quantity: 10, limitPriceCents: toCents("100.00") },
      [{ side: "sell", symbol: "AAPL", quantity: 10, limitPriceCents: toCents("60.00") }],
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts a sell that fits within available (unreserved) shares", () => {
    const result = canPlaceLimitOrder(
      account(0n, { AAPL: { quantity: 10, avgCostCents: toCents("50.00") } }),
      { side: "sell", symbol: "AAPL", quantity: 10, limitPriceCents: toCents("60.00") },
      [],
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a sell that exceeds shares after accounting for another pending sell of the same symbol", () => {
    const result = canPlaceLimitOrder(
      account(0n, { AAPL: { quantity: 10, avgCostCents: toCents("50.00") } }),
      { side: "sell", symbol: "AAPL", quantity: 5, limitPriceCents: toCents("60.00") },
      [{ side: "sell", symbol: "AAPL", quantity: 8, limitPriceCents: toCents("55.00") }],
    );
    expect(result).toEqual({ ok: false, reason: "insufficient_shares" });
  });

  it("does not let a pending sell of a DIFFERENT symbol reserve shares of this one", () => {
    const result = canPlaceLimitOrder(
      account(0n, { AAPL: { quantity: 10, avgCostCents: toCents("50.00") } }),
      { side: "sell", symbol: "AAPL", quantity: 10, limitPriceCents: toCents("60.00") },
      [{ side: "sell", symbol: "TSLA", quantity: 100, limitPriceCents: toCents("200.00") }],
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a sell of a symbol not held at all", () => {
    const result = canPlaceLimitOrder(
      account(0n),
      { side: "sell", symbol: "AAPL", quantity: 1, limitPriceCents: toCents("60.00") },
      [],
    );
    expect(result).toEqual({ ok: false, reason: "insufficient_shares" });
  });

  it("rejects a non-integer or non-positive quantity", () => {
    expect(
      canPlaceLimitOrder(
        account(toCents("1000.00")),
        { side: "buy", symbol: "AAPL", quantity: 0, limitPriceCents: toCents("100.00") },
        [],
      ),
    ).toEqual({ ok: false, reason: "invalid_quantity" });
  });

  it("rejects a zero or negative limit price", () => {
    expect(
      canPlaceLimitOrder(
        account(toCents("1000.00")),
        { side: "buy", symbol: "AAPL", quantity: 1, limitPriceCents: 0n },
        [],
      ),
    ).toEqual({ ok: false, reason: "invalid_limit_price" });
  });
});
