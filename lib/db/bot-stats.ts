import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Cents } from "../trading/money";
import { db } from "./client";
import { botRuns } from "./schema";

export type BotRuleStats = {
  ruleId: string;
  ruleParams: unknown;
  sampleSize: number;
  winCount: number;
  winRate: number; // 0-1
  // Rounded to the nearest cent for display - an average across N real,
  // exact-cent trades is itself a derived statistic, not a real transaction
  // amount, the same "fractional cents are fine for a derived number, never
  // for money actually moving" distinction lib/trading/indicators.ts's own
  // comment already makes for SMA/EMA. null when there are no wins (or no
  // losses) at all to average, not 0 - a 0 would misleadingly claim "the
  // average win was $0.00" instead of "there were no wins yet."
  avgWinCents: Cents | null;
  avgLossCents: Cents | null;
};

// This is "the actual point of the project" (per the design brief) made
// user-facing from day one, not a query only run manually: grouped by
// ruleId + ruleParams together, not ruleId alone, so a future parameter
// tweak to this same rule never silently blends its results into an
// earlier version's sample - each distinct (rule, params) pair is its own
// honest sample. Scoped to CLOSED runs with a real realizedPnlCents only -
// a "selecting"/"holding" run in flight, or a "failed_no_affordable_
// candidate" run that never actually traded, contributes nothing to a
// win-rate/edge question and must not be silently counted as a loss or a
// wash.
export async function getBotRuleStatsForAccount(accountId: string): Promise<BotRuleStats[]> {
  const rows = await db
    .select({
      ruleId: botRuns.ruleId,
      ruleParams: botRuns.ruleParams,
      sampleSize: sql<string>`count(*)`,
      winCount: sql<string>`count(*) filter (where ${botRuns.realizedPnlCents} > 0)`,
      avgWinCents: sql<
        string | null
      >`avg(${botRuns.realizedPnlCents}) filter (where ${botRuns.realizedPnlCents} > 0)`,
      avgLossCents: sql<
        string | null
      >`avg(${botRuns.realizedPnlCents}) filter (where ${botRuns.realizedPnlCents} < 0)`,
    })
    .from(botRuns)
    .where(and(eq(botRuns.accountId, accountId), isNotNull(botRuns.realizedPnlCents)))
    .groupBy(botRuns.ruleId, botRuns.ruleParams);

  return rows.map((row) => {
    const sampleSize = Number(row.sampleSize);
    const winCount = Number(row.winCount);
    return {
      ruleId: row.ruleId,
      ruleParams: row.ruleParams,
      sampleSize,
      winCount,
      winRate: sampleSize > 0 ? winCount / sampleSize : 0,
      avgWinCents:
        row.avgWinCents !== null ? (BigInt(Math.round(Number(row.avgWinCents))) as Cents) : null,
      avgLossCents:
        row.avgLossCents !== null ? (BigInt(Math.round(Number(row.avgLossCents))) as Cents) : null,
    };
  });
}
