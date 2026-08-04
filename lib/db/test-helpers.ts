import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { db } from "./client";
import { accounts, transactions } from "./schema";

// The ledger invariant: an account's current cash balance must always equal
// the sum of every transaction ever recorded for it. Call this at the end of
// any integration test that writes data, not just the test written
// specifically to check it - a bug that corrupts the ledger should fail in
// whichever test introduced it.
export async function assertLedgerBalances(accountId: string): Promise<void> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));

  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  const transactionRows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId));
  const ledgerSum = transactionRows.reduce((sum, row) => sum + row.amountCents, 0n);

  expect(account.cashCents, "account cashCents must equal the sum of all transaction amounts").toBe(
    ledgerSum,
  );
}
