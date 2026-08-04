# Trading Simulator

A paper-trading platform. Real market prices come from Alpaca; all money is virtual. **No real orders are ever placed.**

## Stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript (strict)
- [Supabase](https://supabase.com) - Postgres + Auth
- [Drizzle ORM](https://orm.drizzle.team)
- [Zod](https://zod.dev)
- Tailwind + shadcn/ui
- [Vitest](https://vitest.dev)
- [Alpaca](https://alpaca.markets) - market data

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Supabase project

Create a project at [supabase.com](https://supabase.com). You'll need, from Project Settings:

- **Database → Connection string → Transaction pooler** (port `6543`) for `DATABASE_URL`. This project talks to Postgres directly via Drizzle, not through Supabase's client libraries - the pooler matters because serverless deployments (Vercel) open many short-lived connections, and the direct connection (port 5432) runs out of slots quickly under that load. See `lib/db/client.ts`.
- **API → Project URL** and **API → anon/publishable key** for `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` (used for auth only - this app never queries Postgres through Supabase's client).

### 3. Get Alpaca API keys

Sign up at [app.alpaca.markets](https://app.alpaca.markets), switch to your **Paper Trading** account, and generate an API key pair from the dashboard. These are for market data only - no orders are ever sent to Alpaca.

### 4. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `DATABASE_URL`, `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. `TEST_DATABASE_URL` already has a working default for the local integration-test database (see below).

### 5. Push the schema

```bash
npm run db:push
```

This pushes `lib/db/schema.ts` to your Supabase database (four tables: `accounts`, `positions`, `orders`, `transactions`).

### 6. Enable Row Level Security

Run this once in the Supabase SQL editor, after the tables exist:

```sql
alter table accounts enable row level security;
alter table positions enable row level security;
alter table orders enable row level security;
alter table transactions enable row level security;
```

This enables RLS with **no policies** - no role, including `anon`/`authenticated`, can read or write these tables directly through Supabase's API. All access goes through this app's server-side code instead.

## Commands

| Command                                    | What it does                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `npm run dev`                              | Start the Next.js dev server                                                    |
| `npm run verify`                           | typecheck + unit tests + format check - run this after every change             |
| `npm run test:integration`                 | Integration tests against a real Postgres (see below)                           |
| `npm run check-db`                         | Smoke-test `DATABASE_URL` - connection, pooler detection, parameterized queries |
| `npm run quote -- AAPL`                    | Fetch a live quote from Alpaca and print bid/ask + current market status        |
| `npm run db:push` / `npm run db:push:test` | Push the schema to the real / local test database                               |

### Running integration tests locally

Integration tests hit a real Postgres database. CI runs them against a Postgres service container (see `.github/workflows/ci.yml`); to run them locally:

```bash
docker compose -f docker-compose.test.yml up -d   # disposable local Postgres on port 5433
npm run db:push:test
npm run test:integration
```

## Architecture

- **`lib/trading/`** - pure business logic: money handling, order execution, market hours. No database access, no network calls, no React imports. Every file has a matching `.test.ts`.
- **`lib/db/`** - Drizzle schema and all database queries. Every write happens inside a transaction; the account row is locked (`SELECT ... FOR UPDATE`) before any balance check, so concurrent orders can't both read the same stale balance.
- **`lib/market/`** - the Alpaca client. Every response is validated with Zod before it touches any typed code; quotes are never cached (`cache: "no-store"`).
- **`app/actions/`** - thin Server Actions: validate input, get the authenticated user, call into `lib/db/`. No business rules live here.
- **Money is always `bigint` cents**, never `number` or float, everywhere in the codebase - see `lib/trading/money.ts`.
- **RLS is enabled with no policies.** There is no client-side database access; every read and write goes through server code using the direct Postgres connection, not Supabase's REST/client API.

## Known limitations

- **NYSE holiday data is hardcoded through 2028** (`lib/trading/market-hours.ts`). A test fails once the current date comes within 90 days of that boundary, specifically so this gets noticed and extended well before it would otherwise cause a live order to be wrongly accepted or rejected.
