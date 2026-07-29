# Spec: Dashboard contributions

Status: **approved** (2026-07-29) · Owner: framework

## Problem

The operator landing page (`/dashboard`) currently shows install *status* — agent
count, recent runs, capability coverage. That's ops/admin information, not what a
day-to-day user (an estimator, a bidder) opens the app to see. Users want the
**business** front page: the projects the Prospector says are worth bidding on,
the most recent projects the Bid Indexer pulled in, with a one-click way to jump
into each module.

## Decision

Two moves:

1. **Demote the current dashboard to a Status screen, admin-only.** The
   agent/run/capability view moves to `/status`, gated by `RequireAdmin` and
   surfaced in the Operator section of the nav. Non-admins never see it.

2. **The Dashboard becomes a module contribution surface.** Each module (and,
   later, agent) may optionally contribute one **card** to the dashboard. Core
   aggregates the cards; the UI renders them uniformly. The Dashboard stays the
   default landing for every role.

### The contribution hook (mirrors `digestContribution`)

`module-sdk` gains an optional hook on `ModulePackage`, shaped exactly like the
existing daily-digest hook so a module that already contributes to the digest can
contribute to the dashboard with near-identical code:

```ts
dashboardContribution?: (ctx: DashboardContext<Settings>) => Promise<DashboardContribution | null>;
```

- `DashboardContext` carries `{ user, logger, settings }`. The requesting user is
  passed so contributions can be **per-user** (the Prospector's "worth a look"
  list is scoped to what *this* user hasn't reviewed yet — same as the digest).
- A contribution is a declarative **card**: `{ title, summary?, items[], emptyText?,
  ctaLabel?, ctaHref? }`. Each item is `{ title, subtitle?, href?, badge? }`.
  Returning `null` drops the card entirely (module has nothing to show).
- Data-only by design: no React in the contract. Core renders every card the same
  way, so the dashboard stays visually consistent regardless of which modules an
  install runs.

### Aggregation

`GET /api/dashboard` now returns `{ cards: DashboardCard[] }`. Core iterates
`inventory.listModules()`, and for each module that declares the hook: loads its
persisted settings (defaults applied via the manifest schema), builds a
module-scoped logger, and calls the hook with the requesting user. A hook that
throws is logged and skipped — **one broken module never blanks the whole
dashboard**. Cards preserve module registration order.

`GET /api/status` (new, admin-only) returns the former dashboard payload
(`agentCount`, `recentRuns`, `capabilities`).

### Configurable counts (good-UI)

Counts live where they belong — in each module's own settings, auto-rendered by
the framework's settings form:

- **Prospector**: `dashboardCardSize` (default **10**) — how many recommended
  bids the card previews.
- **Bid Indexer** (C&M repo): `dashboardCardSize` (default **5**) — most recent
  indexed projects. Different default from Prospector on purpose, so the two
  cards feel distinct.

Each setting is a `z.number().int().min(1).max(N).default(...)` with a `.describe()`
help string, so the form renders a bounded number field with inline help — no
custom UI needed.

## "Hard-code for now, customize later"

A module contributes simply by implementing the hook; ordering is registration
order and every contributing card is shown. There is **no** per-install
customization UI yet (choose which cards appear, reorder, hide). Because the
contract is declarative data, that customization is a later, additive layer over
the same hook — no rework of the modules.

## Scope / boundaries

- Prospector's card ships in this framework repo (`modules/prospector`).
- The **Bid Indexer lives in the C&M client repo**, so its card is a small
  follow-up PR there implementing the same hook (~30 lines). The framework stays
  business-agnostic.
- **Agents**: the same hook can be added to `agent-sdk` and aggregated the same
  way. Deferred to a fast-follow — both current content surfaces (Prospector,
  Bid Indexer) are modules, so modules-only proves the mechanism.

## Files

- `packages/module-sdk` — `DashboardContribution` / `DashboardCardItem` /
  `DashboardContext` types + the optional hook on `ModulePackage`.
- `packages/core` — `ModulePackageLike.dashboardContribution` (inventory),
  `collectDashboardCards()` (modules.ts), `GET /api/dashboard` (cards) +
  `GET /api/status` (admin) in routes/admin.ts.
- `packages/ui` — new `Dashboard` (cards renderer) + `Status` (old payload,
  admin-only), routing + nav updates, `Api.getDashboard`/`Api.getStatus`.
- `modules/prospector` — `dashboardCardSize` setting + `dashboardContribution`.
