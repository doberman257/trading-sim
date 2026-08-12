import { eq } from "drizzle-orm";
import type { AccountState, Position } from "../trading/types";
import { db, type DbTransaction } from "./client";
import { accounts, botRuns, orders, positions, transactions } from "./schema";

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

// Wipes every trade this account ever made and restores it to the exact
// state getOrCreateAccount would produce for a brand-new account - same
// starting balance, one seeding deposit transaction, so
// assertLedgerBalances' own invariant (cashCents equals the sum of every
// transaction) holds immediately after a reset the same way it holds after
// a signup. Deliberately does NOT touch watchlist_items: a watchlist is a
// bookmark list, not trading history, and clearing it isn't what "reset my
// account" asks for. Deletes bot_runs too, not just orders/positions/
// transactions - a bot run is trading history the same as a manual order,
// and leaving old bot_runs rows behind while their own tagged orders
// disappear would leave a dangling, half-reset account rather than a
// genuinely fresh one.
//
// Deletion order respects the schema's own foreign keys without relying on
// cascade: transactions reference orders (nullable) and must go first;
// orders reference bot_runs and must go before bot_runs; positions have no
// dependents. All in one transaction, per CLAUDE.md - a reset that deleted
// history but crashed before resetting cash (or vice versa) would be a
// worse bug than the feature it's fixing.
export async function resetAccount(userId: string): Promise<Account> {
  const account = await getOrCreateAccount(userId);

  return db.transaction(async (tx) => {
    await tx.delete(transactions).where(eq(transactions.accountId, account.id));
    await tx.delete(orders).where(eq(orders.accountId, account.id));
    await tx.delete(botRuns).where(eq(botRuns.accountId, account.id));
    await tx.delete(positions).where(eq(positions.accountId, account.id));

    const [reset] = await tx
      .update(accounts)
      .set({ cashCents: STARTING_BALANCE_CENTS })
      .where(eq(accounts.id, account.id))
      .returning();

    if (!reset) {
      throw new Error(`Failed to reset account ${account.id}`);
    }

    await tx.insert(transactions).values({
      accountId: account.id,
      kind: "deposit",
      amountCents: STARTING_BALANCE_CENTS,
      balanceAfterCents: STARTING_BALANCE_CENTS,
    });

    return reset;
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
