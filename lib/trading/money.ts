// Money is always represented in cents as a bigint to avoid float drift.
export type Cents = bigint;
export type Shares = number;

const MONEY_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export function toCents(dollars: string): Cents {
  if (!MONEY_PATTERN.test(dollars)) {
    throw new Error(`Invalid money string: "${dollars}"`);
  }

  const negative = dollars.startsWith("-");
  const unsigned = negative ? dollars.slice(1) : dollars;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const paddedFraction = fraction.padEnd(2, "0");
  const cents = BigInt(whole) * 100n + BigInt(paddedFraction);

  return negative ? -cents : cents;
}

export function formatCents(c: Cents): string {
  const negative = c < 0n;
  const abs = negative ? -c : c;
  const whole = abs / 100n;
  const fraction = abs % 100n;

  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`;
}

export function multiply(price: Cents, qty: Shares): Cents {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error(`Invalid quantity: ${qty}`);
  }

  return price * BigInt(qty);
}
