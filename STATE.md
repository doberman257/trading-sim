# Project State

_Read this at the start of any session doing feature work. Update it at the end of any session that completes a milestone. This file answers "where am I" — see CLAUDE.md for "what are the rules."_

## Current status

The trading core (money handling, order execution, market hours, DB layer with transactional locking) is built, unit-tested (70 tests), integration-tested against a real Postgres (6 tests, including a mechanism-level proof that the row lock is genuinely load-bearing), and passing on GitHub Actions CI (verified live, not assumed — all 4 pushed commits show green). The real Supabase project has the schema pushed and RLS enabled with zero policies (verified by querying it directly, not assumed). Real Alpaca paper-trading credentials are wired up and confirmed working. A visual design system is approved and has one real component (`PositionRow`) built against it. **There is no dashboard yet** — `app/page.tsx` is still the unmodified create-next-app boilerplate, and no Server Action has been wired to real UI.

## Done

- **Scaffolded the project** — Next.js App Router, TS strict (+ `noUncheckedIndexedAccess`, `noImplicitOverride`), Tailwind, Vitest, Prettier. Decided: strict indexed-access on because the app constantly indexes into position/price arrays and empty-case bugs there are exactly the class of bug worth a compiler forcing function.
- **Built `lib/trading/`** (money, types, execute, market-hours, symbol) as pure functions, each with a matching test file. Decided: market hours use `Intl`/IANA timezone data rather than a hardcoded UTC offset, specifically so DST transitions (which differ between US and EU by up to two weeks a year) resolve correctly regardless of server locale.
- **Built `lib/db/`** — schema, transactional order placement with `SELECT ... FOR UPDATE` locking before any funds check. Decided: lock the account row, not just wrap the write in a transaction — a bare transaction doesn't stop two concurrent orders from both reading the same stale balance.
- **Built `lib/market/alpaca.ts`** — Zod-validated at the boundary, `cache: "no-store"`. Decided: convert Alpaca's float prices via `.toFixed(2)` before `toCents()`, never let a float touch arithmetic directly.
- **Wired Supabase auth** (`lib/supabase/server.ts`) and a thin Server Action (`app/actions/trade.ts`) that validates input, gets the authenticated user, and delegates to `lib/db/orders.ts`.
- **Pushed the schema to the real Supabase project and enabled RLS with no policies.** Verified directly against the live database (not just planned): all 4 tables exist, `relrowsecurity = true` on each, zero rows in `pg_policies`.
- **Set up CI** (`.github/workflows/ci.yml`) — unit job with zero environment variables (verified by stripping the env entirely and running clean), integration job against a Postgres service container. Decided: pin Node to `25.6.1` in `package.json` engines + `.nvmrc` + CI's `node-version-file`, matching the actual local dev version exactly rather than picking a different "safer" LTS, because the ask was CI parity with local, not a different tradeoff.
- **Added a `reviewer` subagent** (`.claude/agents/reviewer.md`) and a husky `pre-push` hook running `npm run verify` **and** `npm ci --dry-run`. Decided: `npm ci --dry-run` specifically, not `npm install --package-lock-only` — the latter turned out to mutate the lock file (added optional-dependency metadata) even when `npm ci` already worked, which would have made the drift check noisy and untrustworthy.
- **Approved a visual design system** (`.claude/skills/trading-ui-design/SKILL.md`) — dark, dense, data-first; tokens live in `app/globals.css`'s Tailwind v4 `@theme` block (no `tailwind.config.ts` in this project). Decided: desaturate `--color-loss` from Tailwind's stock red-500 to a custom `#dc5454` — WCAG luminance math showed green-500 was already _more_ luminant than red-500, so the "loss row reads heavier" complaint was a saturation/psychological-prominence issue, not a contrast one; darkening (red-600) was tried and rejected because it dropped contrast below the skill's own WCAG AA floor.
- **Built `PositionRow`** (`components/PositionRow.tsx`) + a preview page (`/dev/position-row`) showing profit/loss/stale states with real `formatCents` output. Decided: extracted market-value/unrealized-P&L math into `lib/trading/pnl.ts` after the reviewer subagent correctly flagged it as business logic living untested in a UI component.
- **Trimmed CLAUDE.md** from 37 to 28 lines (Stack and Structure sections removed — both fully derivable from `package.json` and the folder tree).

## Next

**Build the real positions panel in the actual dashboard**, replacing the `app/page.tsx` boilerplate:

1. Server Component (or a Server Action it calls) that calls `getOrCreateAccount` + `loadAccountState` for the authenticated Supabase user (auth check first — reject/redirect if unauthenticated, same pattern as `app/actions/trade.ts`).
2. Render the result through `PositionRow` inside the skill's Panel pattern, replacing the hardcoded preview-page fixtures with real position data.
3. Fetch a live quote per held symbol (`lib/market/alpaca.ts`) to drive `currentPriceCents` and `isStale`, rather than the static numbers the preview page uses.
4. No order placement UI yet — this step is read-only display. The order ticket is a separate, later milestone.

This is the natural next step because the design is approved and `PositionRow` is already built and tested — the missing piece is exclusively wiring it to real data, not more design or business-logic work.

## Open questions / deferred

- **Limit-order queuing vs. rejection.** Market orders placed while the market is closed are rejected outright (`market_closed`), not queued. Real brokers queue them, but that needs a background worker, fill-time re-validation of funds/shares, and order cancellation — none of which exist yet. Recommendation on record: implement rejection now (honest, simple), build queuing later as its own deliberate milestone rather than half-building it now.
- **2028 Christmas Eve early close is genuinely unresolved**, not just unverified. NYSE hasn't published that far ahead. `lib/trading/market-hours.ts` deliberately omits a `2028-12-24` (or `2028-12-22`) entry rather than guess — check `nyse.com/markets/hours-calendars` closer to the date. `HOLIDAY_DATA_VALID_THROUGH` + a test failing 90 days out will surface this automatically.
- **Supabase pooler behavior under real concurrent load is unverified.** `npm run check-db` confirmed the pooler connection works correctly once, manually, from a single local connection (including proof via `inet_server_port()` that pgbouncer is actually proxying). This has never been tested under many concurrent short-lived connections the way a real Vercel deployment would generate — the app has never actually been deployed anywhere yet.

## Gotchas discovered

- **The concurrency test needed a synchronized mock delay to be trustworthy.** A plain `Promise.all` of two concurrent order placements looked like it tested the row lock, but timing was unreliable: one call's async setup could fully finish (and commit) before the other even started, so the test sometimes passed even with the lock deliberately removed. Fixed by delaying the mocked quote fetch by a fixed amount so both calls clear their pre-transaction work in near-lockstep, forcing genuine overlap — then verified by removing the lock and confirming the test _actually_ failed 4/4 runs, and passed 4/4 with the lock restored.
- **`npm run verify` and `npm ci` catch different classes of failure.** `verify` never reinstalls dependencies, so a `package.json`/`package-lock.json` mismatch is invisible to it — it only surfaces in CI's `npm ci`. That's why the pre-push hook now also runs `npm ci --dry-run`.
- **A skill directory named `design` silently collided with a built-in CLI command** (`/design`). The Skill tool refused to invoke it with an explicit error rather than doing something confusing. Renamed the directory to `trading-ui-design`.
- **A color token named `base` collided with Tailwind's built-in `text-base` utility** (font-size: 1rem) — defining `--color-base` made `text-base` ambiguous between font-size and text-color. Added a separate `--color-on-fg` token for the one place text needed to match the background color, instead of overloading `--color-base`.
- **`.claude/agents/` and `.claude/skills/` need a full quit-and-reopen to be picked up if the directory didn't exist when the session started** — not just a new message, and not fixable by telling Claude to "restart." Both the `reviewer` agent and the `trading-ui-design` skill hit this; work-arounds (running the agent's instructions through a general-purpose agent) confirmed the content was correct while the registration lag was purely a session/watcher issue.
