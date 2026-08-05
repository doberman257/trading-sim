// Money is always represented in cents as a bigint to avoid float drift.
export type Cents = bigint;
export type Shares = number;

// Accepts both plain ("1234.56") and thousands-grouped ("1,234.56") whole
// parts - formatCents below produces the grouped form, and this must be
// able to parse its own output back (see the round-trip test).
const MONEY_PATTERN = /^-?(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/;

export function toCents(dollars: string): Cents {
  if (!MONEY_PATTERN.test(dollars)) {
    throw new Error(`Invalid money string: "${dollars}"`);
  }

  const negative = dollars.startsWith("-");
  const unsigned = (negative ? dollars.slice(1) : dollars).replaceAll(",", "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const paddedFraction = fraction.padEnd(2, "0");
  const cents = BigInt(whole) * 100n + BigInt(paddedFraction);

  return negative ? -cents : cents;
}

// Thousands-grouped by default ("1,234.56", not "1234.56") - per the
// trading-ui-design skill, this applies to every money display in the app,
// not just large summary totals, so there's one formatter to remember
// rather than a grouped and an ungrouped variant call sites could mix up.
export function formatCents(c: Cents): string {
  const negative = c < 0n;
  const abs = negative ? -c : c;
  const whole = abs / 100n;
  const fraction = abs % 100n;

  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}.${fraction.toString().padStart(2, "0")}`;
}

export function multiply(price: Cents, qty: Shares): Cents {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error(`Invalid quantity: ${qty}`);
  }

  return price * BigInt(qty);
}
