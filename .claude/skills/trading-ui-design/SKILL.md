---
name: trading-ui-design
description: Visual design system for this trading simulator's interface — colors, typography, spacing, and component patterns for panels, data tables, order forms, and price displays. Use this skill whenever building or modifying any UI in this project: pages, components, layouts, forms, tables, badges, buttons, or anything a user sees. Also use it when styling existing markup, adding a new screen, or deciding how to display money, percentages, market status, or gain/loss values. If the task touches app/ or any .tsx file that renders, consult this skill first.
---

# Trading UI Design System

Dark, dense, data-first. The reference is the professional trading terminal:
information-dense panels, muted chrome, color reserved almost entirely for
meaning rather than decoration.

**Core principle:** the chrome recedes, the numbers advance. If a visual
element isn't data or an action, it should be quiet.

---

## Tokens

**This project uses Tailwind v4's CSS-first config — there is no
`tailwind.config.ts`.** The tokens live directly in `app/globals.css` inside
an `@theme` block. Every `--color-*` variable defined there automatically
generates the matching `bg-*` / `text-*` / `border-*` / `ring-*` utilities —
there's no separate mapping step to write. Never use raw hex or arbitrary
Tailwind values in components; only the semantic name.

```css
@theme inline {
  /* Surfaces — near-black, layered by elevation */
  --color-base: #0a0a0a; /* page background */
  --color-panel: #141414; /* panel/card */
  --color-elevated: #1a1a1a; /* inputs, hover */
  --color-selected: #262626; /* active toggle, selected row */

  /* Borders — barely visible, structure not decoration */
  --color-default: #262626;
  --color-strong: #333333; /* focus, active panel */

  /* Text */
  --color-fg: #ededed; /* primary */
  --color-muted: #8a8a8a; /* labels, secondary */
  --color-subtle: #5a5a5a; /* disclaimers, disabled */

  /* Text-on-inverted-surface — see the `text-base` collision note below */
  --color-on-fg: #0a0a0a;

  /* Semantic — meaning only, never decoration */
  --color-gain: #22c55e;
  --color-loss: #dc5454; /* desaturated from Tailwind red-500; see note below */
  --color-warn: #eab308; /* stale data, closed market */
  --color-accent: #60a5fa; /* focus rings, links */
}
```

Opacity modifiers (`bg-warn/5`, `border-loss/40`) work automatically on every
token above — Tailwind v4 applies them via `color-mix()` regardless of the
color format, so there's no need for the old `rgb(var(--x) / <alpha-value>)`
pattern from Tailwind v3.

**Don't name a color `base`, `sm`, `lg`, `xl`, or anything else that
collides with one of Tailwind's own scale keys.** `--color-base` is safe for
`bg-base` / `border-base`, but `text-base` is _already_ a built-in Tailwind
utility (`font-size: 1rem`) — defining a color also named `base` makes
`text-base` ambiguous between font-size and text-color, and one meaning
silently wins. That's why the inverted primary button below uses
`text-on-fg`, a dedicated token with the same value as `--color-base`,
instead of reusing `--color-base` as text.

**Why `--color-loss` isn't Tailwind's red-500 (`#ef4444`):** red-500 has
meaningfully higher saturation than green-500 (84% vs. 71%), and WCAG
relative luminance shows green-500 is already _more_ luminant against this
background than red-500 is — so red-500 reads as psychologically "louder"
(warm colors advance) without actually being brighter. `#dc5454` keeps the
same lightness as red-500 (same ~5:1 contrast against `--color-base`, no
accessibility regression) but is desaturated to ~66%, closer to green-500's
71%, specifically so a loss row doesn't read heavier than a gain row of the
same magnitude. If you retune this, recompute contrast against
`--color-base` — don't just eyeball a darker red; darker reds lose contrast
faster than they lose "loudness."

**Hard rule:** `--gain` and `--loss` are for financial direction only. Never
use green for "success" or red for "error" in this app — a red toast next to a
red P&L figure is genuinely confusing. Use `--fg` and `--warn` for system
states.

---

## Typography

```
Numbers:  font-mono, tabular-nums          — always, no exceptions
UI text:  system sans (Inter or -apple-system)
```

Scale:

| Use              | Class                                                    |
| ---------------- | -------------------------------------------------------- |
| Panel title      | `text-sm font-medium text-fg`                            |
| Field label      | `text-xs text-muted`                                     |
| Table header     | `text-xs text-muted font-normal uppercase tracking-wide` |
| Body / cell      | `text-sm text-fg`                                        |
| Primary price    | `text-2xl font-mono tabular-nums text-fg`                |
| Secondary number | `text-sm font-mono tabular-nums`                         |
| Disclaimer       | `text-xs text-subtle leading-snug`                       |

**`tabular-nums` on every number.** Without it, digits have different widths
and columns visually shift as prices update. This is the single most noticeable
difference between an amateur and a professional trading interface.

---

## Money and numbers

```tsx
// ALWAYS through formatCents. Never render a raw bigint, never do math here.
<span className="font-mono tabular-nums">{formatCents(position.marketValue)}</span>
```

Rules:

- Money and percentages: **right-aligned**
- Symbols, names, text: **left-aligned**
- Always show 2 decimals, even for whole values — `264.00`, not `264`
- Percentages: one decimal, always signed — `+0.3%`, `−0.2%`
- **Whole-dollar amounts are thousands-grouped** — `100,000.00`, not
  `100000.00`. This is baked into `formatCents` itself, not a per-component
  choice: `100000.00` is genuinely hard to scan at a glance, and grouping
  needed to apply everywhere money renders or not at all, not just on the
  screen where someone happened to notice it. `toCents` accepts grouped
  input back (`"100,000.00"` and `"100000.00"` parse identically) so
  `formatCents`'s own output stays round-trippable.

**This app is USD only.** There is no currency symbol logic in
`formatCents` and no per-value currency selection anywhere in the UI — every
money value in this system is implicitly USD. If multi-currency ever
becomes a real requirement, that's a deliberate, planned change (touching
`lib/trading/money.ts`, storage, and every display convention below), not
something to improvise in one component because a screen "needs" it.

**Currency indicator: in the value, everywhere — not in the header.**

This reverses an earlier version of this rule (currency in the header,
bare numbers in cells). That version caused real breakage: `AVG COST ($)`,
`FILL PRICE ($)`, and `UNREALIZED P&L ($)` are long enough that `($)` was
what pushed the header onto two lines in a dense column. Dropping it not
only fixed the wrap, it also removed a header/cell inconsistency: every
other place in this app that shows a money value (a cash balance, an order
ticket's estimate) already puts `$` on the value itself, not on a label
above it — table cells were the one exception, and that exception is what
broke.

- **Every money value gets an explicit `$`, full stop** — table cell or
  standalone, no exceptions: `${formatCents(x)}`.
- **Column headers never carry `($)` or any other currency mark.** `Avg
cost`, `Price`, `Market value`, `Fill price` — the value already says
  it's a dollar amount, so the header doesn't need to say it too.
- The old alignment worry (`$150.00` vs. `−$797.00` shifting where the
  digits start) is solved by ordering, not by hiding the `$`: sign first,
  then `$`, then the digits — `+$150.00`, `−$797.00`. `Delta`
  (`components/Delta.tsx`) already does this; follow the same order
  anywhere else a signed money value needs a `$`.
- **`Delta` (`components/Delta.tsx`) takes `showCurrency` as a required
  prop, with no default.** It used to have no `$` logic at all, in any
  branch — the bug only became visible on a `0.00` value (a brand-new
  account has no gain/loss to show a sign on) because that's the one case
  where "no `$` anywhere" and "no `$` because it's flat" look the same by
  accident. Making the caller state `showCurrency` explicitly, every time,
  is what catches this class of mistake before it ships again — a default
  either way would just move the silent-omission risk to whichever context
  didn't match the default.

---

## Gain / loss — never color alone

Roughly 8% of men have some form of color vision deficiency, and red/green is
the most common axis. Color is a redundant channel here, not the primary one.

**Every gain/loss value carries a sign AND a direction glyph AND color.** The
canonical implementation is `components/Delta.tsx` (`formatDeltaAmount` +
`formatDeltaPercent`, plus the `Delta` component itself) — read that file
rather than a duplicated snippet here, since a copy in this doc already
drifted out of sync with the real component once (missing `$`-prefix logic,
fixed by adding the required `showCurrency` prop — see Money and numbers
above).

Use the typographic minus `−` (U+2212), not a hyphen — it aligns with digits
in monospace.

At exactly zero: no glyph, `text-muted`, no sign, percentage reads `0.0%`.

**A nonzero percent can still round to "0.0" at one decimal place** — a
$7.50 loss on a $15,396.50 position is −0.049%, which rounds to `0.0` and,
signed, displays as `−0.0%`. Negative zero reads as a bug, not "a real but
tiny loss," even though nothing here is an actual floating-point negative
zero. `formatDeltaPercent` handles this: exact zero (no change at all)
shows `0.0%`, unsigned; anything nonzero that would otherwise round to zero
shows `<0.1%` instead, with **no sign** — the direction glyph and the exact
cents amount right next to it already say which way it moved, so a sign on
`<0.1%` would answer the same question twice, once precisely (the cents
amount) and once vaguely and redundantly (`-<0.1%`). Once a percent is
large enough to round to a nonzero first decimal, it goes back to the
normal signed form (`+0.3%`, `−0.2%`).

**Order status uses the same discipline.** Never a bare colored word:

```tsx
Filled     → text-fg  with a small filled dot
Rejected   → text-loss with ✕
Cancelled  → text-muted with ○
Pending    → text-warn with ◷
```

---

## Panel

The fundamental layout unit. Every region of the dashboard is a panel.

```tsx
<section className="border-default bg-panel rounded-lg border">
  <header className="border-default flex items-center justify-between border-b px-4 py-2.5">
    <h2 className="text-fg text-sm font-medium">Positions</h2>
    {/* optional: status, actions — kept quiet */}
  </header>
  <div className="p-4">{children}</div>
</section>
```

- Radius: `rounded-lg` everywhere. Don't mix.
- Panels sit on `bg-base` with `gap-3` between them.
- No shadows. Elevation is expressed through background lightness, not blur.

---

## Data table

```tsx
<table className="w-full text-sm">
  <thead>
    <tr className="border-default border-b">
      <th className="text-muted px-3 py-2 text-left text-xs font-normal tracking-wide uppercase">
        Symbol
      </th>
      {/* no "($)" - see Currency indicator above */}
      <th className="text-muted px-3 py-2 text-right text-xs font-normal tracking-wide uppercase">
        Market value
      </th>
    </tr>
  </thead>
  <tbody>
    <tr className="border-default/50 hover:bg-elevated border-b transition-colors">
      <td className="text-fg px-3 py-2.5 font-medium">AAPL</td>
      <td className="px-3 py-2.5 text-right font-mono tabular-nums">${formatCents(v)}</td>
    </tr>
  </tbody>
</table>
```

**Compact, non-wrapping timestamps.** A bare `Intl.DateTimeFormat` result
like `Aug 5, 3:32 PM` is too long for a dense table column and wraps onto
multiple lines. Use relative time for anything recent, falling back to a
short absolute date once relative time stops being useful:

```tsx
function formatOrderTimestamp(date: Date, now: Date): string {
  const diffMinutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(date); // "Aug 5" or "Dec 31, 2025"
}
```

Take `now` as an explicit argument, the same as `getMarketStatus` in
`lib/trading/market-hours.ts` — never default it to `new Date()` inside the
function. The caller (a Server Component render) passes the real current
time once; tests pass an exact fixture. Export the function so its exact
text has unit test coverage — this project has no component-render setup
(no jsdom/testing-library), so testable wording lives in a plain function,
not inline JSX. See `MarketStatusBanner`'s `openMessage`/`closedMessage` and
`Delta`'s `formatDeltaAmount` for the same pattern applied elsewhere.

---

## Panel grid proportions

The dashboard's three panels don't split evenly, because their content
doesn't need equal space:

```tsx
<div className="grid grid-cols-1 gap-3 lg:grid-cols-[320px_3fr_2fr]">
  <OrderTicket /* fixed width */ />
  <PositionsPanel /* 3fr */ />
  <RecentOrdersPanel /* 2fr */ />
</div>
```

- **The order ticket is fixed-width (`320px`), never `fr`.** It's a form
  with a handful of inputs, not content that benefits from extra room -
  giving it a flexible share would either starve the two data panels or
  leave the form awkwardly wide for no reason.
- **The two data panels split the remaining space by column-content
  weight, not evenly.** Count real column width, not column count: Positions
  and Recent orders both have 6 columns, but Positions' `Unrealized P&L`
  column carries a sign, a glyph, a `$` amount, _and_ a percentage in
  parens (`▲ +$1,234.56 (+12.3%)`) - meaningfully wider than anything in
  Recent orders. `3fr`/`2fr` reflects that; a `1fr`/`1fr` split (or a fixed
  px width for either) is what caused the original wrapping bug, because a
  fixed width has no way to adapt to whatever the actual content needs.
- When adding a new panel to this grid, estimate its widest realistic cell
  (not header) across all its columns before picking a share - that's the
  number that actually determines whether it wraps.

---

## Responsive tables

**A `<table>` cannot be responsively restyled with CSS alone below its
breakpoint** — Tailwind's mobile stacking pattern generally works by hiding
and reshaping the same elements, but a `<tr>`/`<td>` rendered outside a
`<table>`/`<tbody>` is invalid HTML and browsers silently drop it, so you
cannot just add mobile-only flex classes to table cells and expect a card
layout to appear. Two genuinely separate markup structures are required:
a `<table>` shown at `lg:` and up, and a stacked card list shown below it.

```tsx
{
  /* Table at lg+ */
}
<table className="hidden w-full text-sm lg:table">{/* ...thead, tbody as normal... */}</table>;

{
  /* Stacked label/value cards below lg */
}
<div className="flex flex-col gap-2 lg:hidden">
  {rows.map((row) => (
    <div key={row.id} className="border-default bg-elevated rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-fg font-medium">{row.symbol}</span>
      </div>
      <div className="flex items-center justify-between py-1">
        <span className="text-muted text-xs">Qty</span>
        <span className="text-fg font-mono text-sm tabular-nums">{row.quantity}</span>
      </div>
      {/* one label/value row per column that was in the table */}
    </div>
  ))}
</div>;
```

If the table row is its own component (e.g. `PositionRow`, a `<tr>`), the
card version is a **separate sibling component** with the same props (e.g.
`PositionCard`, a `<div>`) - not a prop flag on the row component that
switches its root element, since a component that sometimes returns a
`<tr>` and sometimes a `<div>` can't be typed or used cleanly in either
context. Every table this app renders (Positions, Recent orders) follows
this pattern; a new one should too, rather than shipping desktop-only and
letting mobile fall back to horizontal scroll.

Density: `py-2.5` per row. Tight enough to scan many rows, loose enough to read.

Empty state: centered, `text-sm text-muted`, one line, plus a hint at the action
that would fill it. Never a blank panel.

---

## Form controls

**Label/value row** — the dominant pattern in an order ticket:

```tsx
<div className="flex items-center justify-between py-2">
  <span className="text-muted text-xs">Estimated cost</span>
  {/* standalone value, no column header - the $ prefix carries the currency */}
  <span className="text-fg font-mono text-sm tabular-nums">${formatCents(x)}</span>
</div>
```

**Money labels must match the side, not just the number.** "Cost" implies
money leaving the account; a sell brings money in, so a buy/sell form
showing "Estimated cost" on both sides is wrong on one of them, not just
imprecise - money comes in on a sell, it doesn't cost anything. Use
`"Estimated cost (ask)"` for a buy and `"Estimated proceeds (bid)"` for a
sell. This generalizes: anywhere a label names a direction ("cost", "gain",
"due"), check both sides of the toggle it's next to before assuming one
wording covers both.

**Input:**

```tsx
<input className="border-default bg-elevated text-fg placeholder:text-subtle focus:border-strong focus:ring-accent w-full rounded-md border px-3 py-2 font-mono text-sm tabular-nums focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50" />
```

**Buy/Sell segmented toggle** — the one place gain/loss color is used for an
action, because the semantic mapping is genuine:

```tsx
<div className="border-default bg-elevated flex rounded-md border p-0.5">
  <button
    className={
      selected === "buy"
        ? "bg-selected text-gain flex-1 rounded py-1.5 text-sm font-medium"
        : "text-muted hover:text-fg flex-1 rounded py-1.5 text-sm"
    }
  >
    Buy
  </button>
  {/* Sell mirrors with text-loss */}
</div>
```

**Buttons:**

| Kind                              | Style                                                    |
| --------------------------------- | -------------------------------------------------------- |
| Primary                           | `bg-fg text-on-fg font-medium` — inverted, high contrast |
| Secondary                         | `border border-default bg-elevated text-fg`              |
| Ghost                             | `text-muted hover:text-fg`                               |
| Destructive (close full position) | `border border-loss/40 text-loss hover:bg-loss/10`       |

Disabled always pairs with a visible reason nearby — never a dead button with
no explanation.

---

## Market status and stale data

This is a simulator whose entire value is honest pricing. The user must never
mistake a stale price for a live one.

**Banner, always present at the top of the dashboard:**

```tsx
// Open
<div className="flex items-center gap-2 text-xs text-muted">
  <span className="size-1.5 rounded-full bg-gain" />
  Market open · closes 4:00 PM ET
</div>

// Closed
<div className="flex items-center gap-2 rounded-md border border-warn/30
                bg-warn/5 px-3 py-2 text-xs text-warn">
  <span className="size-1.5 rounded-full bg-warn" />
  Market closed — prices shown are from the last close.
  Opens Monday 9:30 AM ET.
</div>
```

**Stale prices are dimmed, not hidden.** When the market is closed or a quote
is older than 60s, apply `opacity-60` to price values. The number stays
readable; the reduced weight signals it isn't live.

**Loading:** show a skeleton block, never a zero and never the previous value
without dimming. A trading UI that renders `0.00` while loading is worse than
one that renders nothing.

---

## Motion

Minimal. This is a data interface, not a marketing page.

- Allowed: `transition-colors duration-150` on hover/focus
- Allowed: brief background flash on a price change (`bg-gain/10` fading over
  ~400ms), if it earns its place
- Not allowed: entrance animations, layout-shifting transitions, spinners
  longer than a moment, anything that moves a number the user is reading

Respect `prefers-reduced-motion` for the price flash.

---

## Layout

Dashboard is a panel grid, not a centered column:

```tsx
<main className="bg-base min-h-screen p-3">
  <div className="grid grid-cols-1 gap-3 lg:grid-cols-[320px_1fr_360px]">
    {/* order ticket | positions + chart | orders */}
  </div>
</main>
```

Spacing scale: `1.5 / 2 / 2.5 / 3 / 4 / 6` only. Nothing else.

Mobile: panels stack full-width, order ticket first. Tables become stacked
label/value cards rather than horizontally scrolling.

---

## shadcn/ui normalization

shadcn/ui components are added by copying source into `components/ui/`, not
installed as a black box — so every rule below is something you fix once
per component, in that copied source, not something to work around at the
call site.

**Alias shadcn's expected variable names to these tokens in `globals.css`,
don't let shadcn generate its own `:root` block.** shadcn's default
components reference `bg-background`, `text-foreground`, `border-input`,
`ring-ring`. Those variables don't exist in this system (`background` /
`foreground` were removed - see Tokens). Add these aliases once so
un-customized shadcn components inherit the right palette automatically
instead of rendering unstyled:

```css
@theme inline {
  /* ...the tokens above, plus: */
  --color-background: var(--color-base);
  --color-foreground: var(--color-fg);
  --color-border: var(--color-default);
  --color-input: var(--color-elevated);
  --color-ring: var(--color-accent);
}
```

**Do not let `muted` or `accent` mean shadcn's defaults.** shadcn's `muted`
is normally a background shade; this system's `--color-muted` is a _text_
color for labels. shadcn's `accent` is normally a hover-state background;
this system's `--color-accent` is focus-ring/link blue. If `shadcn init`
tries to (re)define `muted` or `accent`, don't accept its values - keep
ours, and point shadcn's own internal uses of those names at different
variable names if needed rather than overloading ours.

**`destructive` maps to `--color-warn`, never to red.** shadcn's destructive
button variant is red by convention. This system's hard rule is that red
means financial loss, full stop - a "close full position" button using the
same red as a losing P&L figure is exactly the confusion the Tokens hard
rule warns about. Remap `destructive` to `--color-warn` when customizing
the Button component's variants.

**Override radius per component after adding it.** shadcn's default
components mix `rounded-md` / `rounded-sm` / `rounded-full` across buttons,
inputs, and badges. This system uses `rounded-lg` everywhere, no exceptions

- edit each component's source after `shadcn add` to match.

**Decline or delete the light-mode scaffolding.** This is one fixed dark
theme, not a light/dark toggle. `shadcn init` typically scaffolds a `.dark`
class with light values in `:root`; either skip that step or delete the
light-mode block immediately rather than maintaining an unused theme.

---

## Anti-patterns

Explicitly forbidden in this project:

- Raw Tailwind palette in components — `bg-blue-500`, `text-gray-400`, etc.
  Semantic tokens only.
- Arbitrary values — `p-[13px]`, `text-[#1e1e1e]`. Use the scale.
- Numbers without `tabular-nums`.
- Gain/loss communicated by color alone, with no sign or glyph.
- Green/red used for success/error messaging.
- Shadows for elevation. Use background lightness.
- Rendering a raw `bigint`, or doing money arithmetic inside a component.
  All money goes through `formatCents`; all math lives in `lib/trading/`.
- Showing a price with no indication of whether it's live.
- shadcn defaults left unstyled — every added component gets mapped to these
  tokens before use.
- Mixed radii, mixed border colors, ad-hoc spacing.

---

## Accessibility floor

- All text meets WCAG AA on its background. `--fg-subtle` is for
  non-essential text only.
- Focus is always visible: `focus:ring-1 focus:ring-accent`.
- Gain/loss values carry an `aria-label` spelling out direction and amount.
- Tables use real `<th>` with scope. Screen readers announce columns.
- Interactive elements reach 40px touch height on mobile even where the visual
  box is smaller.
