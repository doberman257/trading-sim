import { describe, expect, it } from "vitest";
import { getMarketStatus } from "@/lib/trading/market-hours";
import { toCents } from "@/lib/trading/money";
import { describeRejection, estimatedAmountLabel, limitOrderAmountLabel } from "./orderMessages";

function utc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

// Wed Jun 10 2026, 10:00 ET - a plain open trading day, used wherever the
// specific market status isn't the point of the test.
const OPEN_STATUS = getMarketStatus(utc(2026, 6, 10, 14, 0));

describe("estimatedAmountLabel", () => {
  it("calls a buy a cost", () => {
    expect(estimatedAmountLabel("buy")).toBe("Estimated cost (ask)");
  });

  it("calls a sell proceeds, not a cost - money comes in, not out", () => {
    expect(estimatedAmountLabel("sell")).toBe("Estimated proceeds (bid)");
  });
});

describe("limitOrderAmountLabel", () => {
  it("calls a buy's bound a max cost, not an estimate - the guarantee is firmer than that", () => {
    expect(limitOrderAmountLabel("buy")).toBe("Max cost (limit)");
  });

  it("calls a sell's bound min proceeds", () => {
    expect(limitOrderAmountLabel("sell")).toBe("Min proceeds (limit)");
  });
});

describe("describeRejection", () => {
  it("shows needed vs available for insufficient_funds", () => {
    const message = describeRejection("insufficient_funds", {
      symbol: "AAPL",
      heldQuantity: 0,
      neededCents: toCents("15000.00"),
      availableCents: toCents("100.00"),
      marketStatus: OPEN_STATUS,
    });
    expect(message).toBe(
      "Insufficient funds: this order needs 15,000.00, but only 100.00 is available.",
    );
  });

  it("falls back to just the available amount when the needed amount is unknown", () => {
    const message = describeRejection("insufficient_funds", {
      symbol: "AAPL",
      heldQuantity: 0,
      neededCents: null,
      availableCents: toCents("100.00"),
      marketStatus: OPEN_STATUS,
    });
    expect(message).toBe("Insufficient funds: only 100.00 is available.");
  });

  it("shows how many shares are held for insufficient_shares", () => {
    const message = describeRejection("insufficient_shares", {
      symbol: "TSLA",
      heldQuantity: 3,
      neededCents: null,
      availableCents: 0n,
      marketStatus: OPEN_STATUS,
    });
    expect(message).toBe("You only hold 3 shares of TSLA.");
  });

  it("uses singular 'share' for exactly one held share", () => {
    const message = describeRejection("insufficient_shares", {
      symbol: "TSLA",
      heldQuantity: 1,
      neededCents: null,
      availableCents: 0n,
      marketStatus: OPEN_STATUS,
    });
    expect(message).toBe("You only hold 1 share of TSLA.");
  });

  it("says the symbol isn't held at all when heldQuantity is zero", () => {
    const message = describeRejection("insufficient_shares", {
      symbol: "TSLA",
      heldQuantity: 0,
      neededCents: null,
      availableCents: 0n,
      marketStatus: OPEN_STATUS,
    });
    expect(message).toBe("You don't hold any shares of TSLA.");
  });

  it("shows when the market next opens for market_closed", () => {
    // Sat Jun 13 2026 - reuses MarketStatusBanner's own closedMessage
    // wording, so this doesn't duplicate that logic.
    const weekendStatus = getMarketStatus(utc(2026, 6, 13, 14, 0));
    const message = describeRejection("market_closed", {
      symbol: "AAPL",
      heldQuantity: 0,
      neededCents: null,
      availableCents: 0n,
      marketStatus: weekendStatus,
    });
    expect(message).toBe("Market closed for the weekend — opens Monday at 9:30 AM ET.");
  });

  it("suggests refreshing for stale_quote", () => {
    const message = describeRejection("stale_quote", {
      symbol: "AAPL",
      heldQuantity: 0,
      neededCents: null,
      availableCents: 0n,
      marketStatus: OPEN_STATUS,
    });
    expect(message.toLowerCase()).toContain("try submitting again");
  });

  it("gives inline validation guidance for invalid_quantity", () => {
    const message = describeRejection("invalid_quantity", {
      symbol: "AAPL",
      heldQuantity: 0,
      neededCents: null,
      availableCents: 0n,
      marketStatus: OPEN_STATUS,
    });
    expect(message).toBe("Enter a whole number of shares greater than zero.");
  });

  it("gives inline validation guidance for invalid_limit_price", () => {
    const message = describeRejection("invalid_limit_price", {
      symbol: "AAPL",
      heldQuantity: 0,
      neededCents: null,
      availableCents: 0n,
      marketStatus: OPEN_STATUS,
    });
    expect(message).toBe("Enter a limit price greater than zero.");
  });

  it('explains "no_quote" without implying the market is closed', () => {
    const message = describeRejection("no_quote", {
      symbol: "AAPL",
      heldQuantity: 0,
      neededCents: null,
      availableCents: 0n,
      marketStatus: OPEN_STATUS,
    });
    expect(message).toContain("AAPL");
  });
});
