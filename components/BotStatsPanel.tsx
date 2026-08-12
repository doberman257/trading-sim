import { formatCents, type Cents } from "@/lib/trading/money";

// No "use client" here - this component has no interactivity, so it stays
// a Server Component and is rendered directly by the dashboard page (also
// a Server Component). Money crosses as plain bigint, not a string: the
// "cross as a string" convention elsewhere in this app (see OrderTicket's
// cashCentsString) exists specifically for the Server -> Client boundary,
// where a value actually gets serialized into the RSC payload - there's no
// such boundary between two Server Components in the same render.
export type BotRuleStatsItem = {
  ruleId: string;
  ruleParams: unknown;
  sampleSize: number;
  winCount: number;
  winRate: number;
  avgWinCents: Cents | null;
  avgLossCents: Cents | null;
};

function formatRuleParams(params: unknown): string {
  if (params === null || typeof params !== "object") return "";
  return Object.entries(params as Record<string, unknown>)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

// "The actual point of the project," per the design brief - answers,
// honestly, whether this rule shows any real edge or is statistically
// indistinguishable from random entries. Deliberately shows sample size
// prominently: a 3-trade win rate and a 300-trade win rate are not the same
// kind of claim, and this panel should never let one look as confident as
// the other.
export function BotStatsPanel({ stats }: { stats: BotRuleStatsItem[] }) {
  return (
    <section className="border-default bg-panel rounded-lg border">
      <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-fg text-sm font-medium">Bot rule stats</h2>
      </header>
      <div className="p-4">
        {stats.length === 0 ? (
          <p className="text-muted py-6 text-center text-sm">
            No closed bot trades yet - stats appear here once at least one run has closed.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {stats.map((row) => (
              <div
                key={`${row.ruleId}:${formatRuleParams(row.ruleParams)}`}
                className="border-default bg-elevated rounded-md border p-3"
              >
                <div className="text-fg text-sm font-medium">{row.ruleId}</div>
                <div className="text-subtle text-xs">{formatRuleParams(row.ruleParams)}</div>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Sample size" value={String(row.sampleSize)} />
                  <Stat label="Win rate" value={`${(row.winRate * 100).toFixed(1)}%`} />
                  <Stat
                    label="Avg win"
                    value={row.avgWinCents !== null ? `$${formatCents(row.avgWinCents)}` : "—"}
                  />
                  <Stat
                    label="Avg loss"
                    value={row.avgLossCents !== null ? `−$${formatCents(-row.avgLossCents)}` : "—"}
                  />
                </div>
                {row.sampleSize < 20 && (
                  <p className="text-subtle mt-2 text-xs leading-snug">
                    Sample size is small - not enough trades yet to tell a real edge apart from
                    noise.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-subtle text-xs">{label}</div>
      <div className="text-fg font-mono text-sm tabular-nums">{value}</div>
    </div>
  );
}
