import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { toCents } from "../trading/money";
import { getOrCreateAccount } from "./accounts";
import { getBotRuleStatsForAccount } from "./bot-stats";
import { db } from "./client";
import { botRuns } from "./schema";

// Directly inserts a closed bot_runs row - this file's job is proving the
// aggregation query, not the full selection/monitoring lifecycle that
// produces a closed run in production (already covered by
// bot-runs.test.ts), so a hand-built row is the right scope here rather
// than running the whole worker to get one.
async function insertClosedRun(
  accountId: string,
  ruleId: string,
  ruleParams: object,
  realizedPnlCents: bigint,
): Promise<void> {
  await db.insert(botRuns).values({
    accountId,
    status: realizedPnlCents >= 0n ? "closed_target" : "closed_stop_loss",
    ruleId,
    ruleParams,
    capitalCents: toCents("1000.00"),
    profitTargetType: "dollar",
    profitTargetValueCents: toCents("50.00"),
    stopLossType: "dollar",
    stopLossValueCents: toCents("30.00"),
    entryTotalCents: toCents("1000.00"),
    entryQuantity: 10,
    realizedPnlCents,
    closedAt: new Date(),
  });
}

async function insertOpenRun(accountId: string): Promise<void> {
  await db.insert(botRuns).values({
    accountId,
    status: "holding",
    ruleId: "rsi_pullback_uptrend_v1",
    ruleParams: { rsiPeriod: 14 },
    capitalCents: toCents("1000.00"),
    profitTargetType: "dollar",
    profitTargetValueCents: toCents("50.00"),
    stopLossType: "dollar",
    stopLossValueCents: toCents("30.00"),
  });
}

beforeEach(async () => {
  await db.execute(sql`truncate table bot_runs, accounts cascade`);
});

describe("getBotRuleStatsForAccount", () => {
  it("computes win rate, average win, and average loss over closed runs only", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    const params = { rsiPeriod: 14, rsiEntryThreshold: 30, rsiExitThreshold: 50, smaPeriod: 50 };

    await insertClosedRun(account.id, "rsi_pullback_uptrend_v1", params, toCents("50.00"));
    await insertClosedRun(account.id, "rsi_pullback_uptrend_v1", params, toCents("30.00"));
    await insertClosedRun(account.id, "rsi_pullback_uptrend_v1", params, -toCents("40.00"));
    // An open run must not be counted at all - neither as a win nor a loss.
    await insertOpenRun(account.id);

    const stats = await getBotRuleStatsForAccount(account.id);
    expect(stats).toHaveLength(1);
    const row = stats[0];
    expect(row?.sampleSize).toBe(3);
    expect(row?.winCount).toBe(2);
    expect(row?.winRate).toBeCloseTo(2 / 3);
    expect(row?.avgWinCents).toBe(toCents("40.00")); // (50 + 30) / 2
    expect(row?.avgLossCents).toBe(-toCents("40.00"));
  });

  it("keeps different rule parameter versions in separate rows", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);

    await insertClosedRun(
      account.id,
      "rsi_pullback_uptrend_v1",
      { rsiEntryThreshold: 30 },
      toCents("10.00"),
    );
    await insertClosedRun(
      account.id,
      "rsi_pullback_uptrend_v1",
      { rsiEntryThreshold: 25 },
      toCents("20.00"),
    );

    const stats = await getBotRuleStatsForAccount(account.id);
    expect(stats).toHaveLength(2);
    expect(stats.every((row) => row.sampleSize === 1)).toBe(true);
  });

  it("returns an empty list when there are no closed runs yet", async () => {
    const userId = randomUUID();
    const account = await getOrCreateAccount(userId);
    await insertOpenRun(account.id);

    const stats = await getBotRuleStatsForAccount(account.id);
    expect(stats).toEqual([]);
  });

  it("is scoped to the given account, not global across every account", async () => {
    const account1 = await getOrCreateAccount(randomUUID());
    const account2 = await getOrCreateAccount(randomUUID());
    await insertClosedRun(
      account1.id,
      "rsi_pullback_uptrend_v1",
      { rsiPeriod: 14 },
      toCents("10.00"),
    );

    expect(await getBotRuleStatsForAccount(account2.id)).toEqual([]);
    const account1Stats = await getBotRuleStatsForAccount(account1.id);
    expect(account1Stats).toHaveLength(1);
  });
});
