import { eq } from "drizzle-orm";
import type { AccountState, Position } from "../trading/types";
import { db, type DbTransaction } from "./client";
import { accounts, positions, transactions } from "./schema";

const STARTING_BALANCE_CENTS = 10_000_000n; // $100,000.00

export type Account = typeof accounts.$inferSelect;

export async function getOrCreateAccount(userId: string): Promise<Account> {
  const [existing] = await db.select().from(accounts).where(eq(accounts.userId, userId));

  if (existing) {
    return existing;
  }

  return db.transaction(async (tx) => {
    // onConflictDoNothing makes this safe if two requests race to create the
    // same user's account: only one insert wins, and only the winner writes
    // the deposit transaction below.
    const [created] = await tx
      .insert(accounts)
      .values({ userId, cashCents: STARTING_BALANCE_CENTS })
      .onConflictDoNothing({ target: accounts.userId })
      .returning();

    if (created) {
      await tx.insert(transactions).values({
        accountId: created.id,
        kind: "deposit",
        amountCents: STARTING_BALANCE_CENTS,
        balanceAfterCents: STARTING_BALANCE_CENTS,
      });

      return created;
    }

    const [account] = await tx.select().from(accounts).where(eq(accounts.userId, userId));

    if (!account) {
      throw new Error(`Failed to get or create account for user ${userId}`);
    }

    return account;
  });
}

export async function loadAccountState(
  tx: DbTransaction,
  accountId: string,
): Promise<AccountState> {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId));

  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  const positionRows = await tx.select().from(positions).where(eq(positions.accountId, accountId));

  const positionMap = new Map<string, Position>(
    positionRows.map((row) => [
      row.symbol,
      { quantity: row.quantity, avgCostCents: row.avgCostCents },
    ]),
  );

  return { cashCents: account.cashCents, positions: positionMap };
}
