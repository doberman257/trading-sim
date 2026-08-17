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

### 7. Configure the limit-order worker (optional, needed for limit orders to actually fill)

Placing a limit order works without this - it just sits `pending` forever until something calls the worker route. To have that happen automatically:

1. Generate a random secret (e.g. `openssl rand -hex 32`) and set it as `LIMIT_ORDER_WORKER_SECRET` in your deployment's environment variables (and in `.env.local` for local testing).
2. In this repository's GitHub Settings → Secrets and variables → Actions, add:
   - `WORKER_URL` - your deployed app's base URL (e.g. `https://your-app.vercel.app`), no trailing slash.
   - `LIMIT_ORDER_WORKER_SECRET` - the same value from step 1.
3. `.github/workflows/limit-order-worker.yml` calls `POST {WORKER_URL}/api/worker/limit-orders` every 5 minutes with that secret as a bearer token. `.github/workflows/keepalive.yml` makes a small monthly commit so GitHub doesn't auto-disable that schedule after 60 days of repo inactivity.

**Swapping the scheduler later is a config change, not a rewrite.** All the actual logic (claiming pending orders, checking fill conditions, the day-order expire sweep) lives behind the one `POST /api/worker/limit-orders` route, written to be safe under irregular invocation - no assumption of a fixed interval, that the previous run happened, or that it ran during market hours. Pointing Vercel Cron (or any other scheduler) at that same URL with the same bearer secret is the entire migration; nothing about the route itself needs to change.

### 8. Configure the bot worker (optional, needed for the autonomous bot's runs to actually progress)

Same secret as step 7 above - `POST /api/worker/bot-runs` (`app/api/worker/bot-runs/route.ts`) is authorized by the exact same `LIMIT_ORDER_WORKER_SECRET`, not a second one, so no new secret to generate if you've already done step 7.

`.github/workflows/bot-worker.yml` calls `POST {WORKER_URL}/api/worker/bot-runs` every 5 minutes with that same bearer token, same cadence as the limit-order worker - a real manual `workflow_dispatch` run was verified first (a real 200, correct evaluation across the full watchlist) before the schedule was added. It can still be triggered by hand from this repository's Actions tab → "Bot worker" → "Run workflow" for a spot-check outside the regular cadence.

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
- **`lib/db/`** - Drizzle schema and all database queries. Every write happens inside a transaction; the relevant row is locked (`SELECT ... FOR UPDATE`) before any balance/status check, so concurrent operations can't both read the same stale state.
- **`lib/market/`** - the Alpaca client. Every response is validated with Zod before it touches any typed code; quotes are never cached (`cache: "no-store"`).
- **`app/actions/`** - thin Server Actions: validate input, get the authenticated user, call into `lib/db/`. No business rules live here.
- **`app/api/`** - Route Handlers, for anything that needs to be callable by more than this app's own browser session. Limit order placement and cancellation live here, not as Server Actions, specifically so a future API-key-authenticated client (a bot) can call them directly - a Server Action can only ever be invoked from inside this app's own React tree, which has no meaning to an external caller. `lib/auth/session.ts`'s `getAuthenticatedUserId` is the one place every Route Handler answers "who is making this request" - today that's a Supabase session cookie only, structured so an API-key branch can slot in later without every route changing. If a Server Action ever needs the same logic, it should call the Route Handler (a thin client of it), not the other way around.
- **Limit orders** rest as `pending` until a background worker (`POST /api/worker/limit-orders`, `lib/db/limit-order-worker.ts`) either fills them or, at market close, expires them - see the Setup section above for wiring up the scheduler, and `STATE.md` for the full design (derived fund/share reservation instead of a new column, row-lock claiming instead of a "processing" status, day orders only).
- **Money is always `bigint` cents**, never `number` or float, everywhere in the codebase - see `lib/trading/money.ts`.
- **RLS is enabled with no policies.** There is no client-side database access; every read and write goes through server code using the direct Postgres connection, not Supabase's REST/client API.

## Known limitations

- **NYSE holiday data is hardcoded through 2028** (`lib/trading/market-hours.ts`). A test fails once the current date comes within 90 days of that boundary, specifically so this gets noticed and extended well before it would otherwise cause a live order to be wrongly accepted or rejected.
- **A limit order placed while the market is closed can be expired within minutes, not preserved until the next session.** The worker's day-order sweep expires every pending limit order on any invocation where the market is closed, not just ones placed earlier that day - a deliberate simplification that stays correct under an irregular/gapped schedule without extra bookkeeping, at the cost of "day order" not quite meaning "survives until the next open" if you place one after hours. See `lib/db/limit-order-worker.ts`.
- **The worker's schedule (GitHub Actions, every 5 minutes) is best-effort, not real-time.** A limit order's fill can lag its price condition being met by up to one scheduling interval. `GET /api/worker/status` (session-authenticated) reports how long it's actually been since the worker last ran, and the dashboard/stock detail pages show a visible warning on pending orders if that's abnormally long.
