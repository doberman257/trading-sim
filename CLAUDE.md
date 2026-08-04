Trading Simulator

A paper-trading platform. Real market prices from Alpaca, virtual money only. No real orders are ever placed.

Stack

Next.js (App Router) · TypeScript strict · Supabase (Postgres + Auth) Drizzle ORM · Zod · Tailwind + shadcn/ui · Vitest · Prettier

Hard rules
No any. If a type is unknown, use unknown and validate with Zod.
Money is always bigint in cents. Never number, never float. $12.34 is 1234n. Use helpers in lib/trading/money.ts.
Business logic lives in lib/trading/ as pure functions. No database access, no network calls, no React imports in that folder. Every file there has a matching .test.ts.
Every database write happens inside a transaction.
Every external API response is validated with Zod at the boundary, before it reaches any typed code.
No client-side database access. RLS is enabled with no policies. All reads and writes go through server code.
Never cache market data. Use cache: "no-store" on quote fetches.
Trading domain rules
Buy orders fill at the ask price. Sell orders fill at the bid price. Never use a single "current price" — the spread must be modeled.
Reject quotes older than 60 seconds (stale_quote).
Order rejection is a normal outcome, not an exception. Return a discriminated union (OrderResult), do not throw.
Average cost changes on buy, stays the same on sell.
Realized P&L is only computed on sell.
Verification — required after every change
npm run verify

This runs typecheck, test, and format:check. Do not consider a task complete until it passes. If a test fails, fix the code — do not weaken the test.

Structure
lib/trading/ Pure business logic + tests (money, types, execute)
lib/db/ Drizzle schema and queries
lib/market/ Alpaca client, Zod schemas for external data
app/ Pages and Server Actions
Conventions
Comments and identifiers in English.
Test descriptions state the behavior being verified, not the function name. Good: "buy fills at ask, not bid". Bad: "executeMarketOrder works".
Prefer explicit return types on exported functions.
Keep Server Actions thin: fetch quote → call pure logic → persist. No business rules inside the action itself.
