# Decision layer — autonomy levels + approval inbox

**Date:** 2026-06-24. **Status:** Proposed (implementation spec).
**PRD:** [/PRD.md](../../PRD.md) → "What we're building next — the decision layer" (P0).

This is the framework primitive that turns "agents that run and log an outcome" into "agents the client trusts to act on their behalf." It is the #2 item in the email-agents work (after wiring agents to a shared inbox) and the foundation the per-user scoping work (#3) builds on.

## Problem

Agents today run to completion and either observe or act outright (e.g. `inbox-cleanup` calls `inbox.archive(ids)` directly, gated only by a crude `dry-run | archive | trash` setting). There is no way to say "let the agent *propose* this, but a human approves before it happens," and no way to graduate an agent from supervised to autonomous as trust grows. No client will let an agent touch a customer mailbox without that.

## Goal

- A per-agent **autonomy level** the operator sets in the settings UI (runtime, no code change).
- Agents **propose actions**; depending on autonomy + action risk, the framework either executes immediately or parks the action for human approval.
- An operator **approval inbox** to approve / edit / reject parked actions.
- Everything audited; the operator can demote an agent back to supervised instantly.

## Non-goals

- No visual workflow builder (locked out in `CLAUDE.md`).
- No multi-tenant sharing — single-tenant per install stays.
- Not a general task queue; this is specifically human-gated *agent actions*.

## Autonomy ladder

A single per-agent dial, framework-injected into every agent's settings (agents don't define it themselves):

| Level | Name | Behavior |
|---|---|---|
| **L0** | Observe | Agent may read + propose, but nothing executes. Proposals are recorded as informational (or suppressed). |
| **L1** | Draft + approve (HITL) | Every proposed action parks in the approval inbox; a human approves/edits/rejects before it runs. **Default for new agents.** |
| **L2** | Act + notify | Actions at/below a risk threshold execute automatically and notify; above-threshold actions still park for approval. |
| **L3** | Autonomous | All actions execute; still fully audited + visible in the activity feed. |

Refinement (phase 2): the dial is per-action-*class*, not just per-agent — "auto-approve actions with risk ≤ X." v1 ships the per-agent dial + a per-action `risk` tag so L2's threshold has something to compare against.

## Agent SDK — `ctx.proposeAction` + action handlers

Agents split **deciding** from **executing**. They declare named action handlers in the manifest and call `ctx.proposeAction` instead of acting directly:

```ts
manifest: {
  ...,
  // Named, side-effecting operations this agent can perform. Each is a pure
  // executor: given the payload, do the thing. The framework decides WHEN.
  actions: {
    archive: { risk: 'low',  run: (ctx, payload: { ids: string[] }) => inbox.archive(payload.ids) },
    trash:   { risk: 'high', run: (ctx, payload: { ids: string[] }) => inbox.trash(payload.ids) },
  },
}

// inside run():
await ctx.proposeAction('archive', { ids }, { summary: `Archive ${ids.length} from ${sender}` });
```

`ctx.proposeAction(kind, payload, { summary })`:
- Resolves the agent's autonomy level + the action's `risk`.
- **Execute-now** (L3, or L2 with `risk ≤ threshold`): invokes the handler inline, records an executed audit row, returns `{ executed: true }`.
- **Park** (L1, or L2 above threshold): inserts a `pending_actions` row (status `pending`), fires a notification, returns `{ executed: false, pendingId }`. Does NOT run the handler.
- **L0**: records the proposal as informational; never executes.

This fits the stateless, run-to-completion model: the agent's `run()` finishes after proposing; approved actions execute later via a framework job that calls the agent's declared handler — no suspended workers, no holding a pg-boss slot.

## Data model — `pending_actions`

```
id            uuid pk
agent_slug    text not null
run_id        uuid            -- the run that proposed it (audit/correlation)
action_kind   text not null   -- matches a key in manifest.actions
payload       jsonb not null
summary       text not null   -- human-readable, shown in the inbox
risk          text not null   -- low | medium | high
status        text not null   -- pending | approved | rejected | executed | failed
owner_user_id uuid            -- (phase 3) which user's scope this belongs to; null = org
decided_by    uuid            -- user who approved/rejected
decided_at    timestamptz
executed_at   timestamptz
result        jsonb           -- handler result or error
created_at    timestamptz not null default now()
```

GIN/index on `(status, agent_slug)`; index on `created_at`.

## Runtime enforcement

- `runtime` builds `ctx.proposeAction` using the resolved autonomy level (from settings) + the manifest action's risk.
- Approval flow: `POST /approvals/:id/approve` → enqueue `module-or-agent:<slug>:execute-action` with `{ pendingId }` → handler loads the row, calls `manifest.actions[kind].run(ctx, payload)`, stamps `executed`/`failed` + result. `reject` just stamps `rejected`.
- Demotion is immediate: lowering the dial means the next `proposeAction` parks instead of executes; in-flight pending actions are unaffected.

## Settings — the autonomy dial

The framework injects a standard `_autonomy: { level: 'L0'|'L1'|'L2'|'L3', riskThreshold?: 'low'|'medium' }` block into every agent's settings form (rendered above the agent's own settings). Stored in the existing `settings` table under the agent's scope. Agents read it only via the framework; they never define it.

## Operator UI — the approval inbox

- New top-level "Approvals" page: list of `pending` actions (newest first), each showing agent, summary, risk, payload preview, and **Approve / Reject** (Approve optionally opens an edit-payload step). A count badge in the shell nav.
- The per-agent Detail page shows that agent's pending + recently-decided actions.
- Builds on the existing run-history UI; reuses `RunDetailsRenderer` for payload preview.

## Notifications

On a new `pending` action (and on `failed` execution), notify the operator. v1: in-UI badge + optional email via the framework's transactional email (Resend/Postmark). Phase 2: route through a per-client Slack/email connector. (An approval inbox nobody is pinged about is useless.)

## Audit

Every transition writes an audit row (`proposed`, `auto_executed`, `approved`, `rejected`, `executed`, `failed`) with `run_id` + `pending_id` for correlation, per the audit-log convention.

## First adopter — `inbox-cleanup`

Replace its direct `inbox.archive/trash` + `dry-run|archive|trash` dial with declared `archive`/`trash` actions + `ctx.proposeAction`. The old dial maps onto the ladder: dry-run ≈ L0, "archive with approval" ≈ L1, prior auto-archive ≈ L2/L3. `inbox-surface` stays read-only (nothing to approve). This proves the primitive end-to-end on a real shared inbox.

## Assisted graduation (phase 2)

Surface "this agent's last N proposals were approved M times — promote to L2?" using `pending_actions` history. Trust earned with data, not a blind flip.

## Implementation order

1. `pending_actions` table + migration (core-owned).
2. Agent-SDK: `manifest.actions` type + `ctx.proposeAction`; framework-injected `_autonomy` settings block.
3. Runtime: autonomy resolution, execute-now vs park, the `execute-action` job + handler dispatch.
4. Core API: list/approve/reject routes + audit + notification hook.
5. Operator UI: Approvals page + nav badge + per-agent section.
6. Adopt in `inbox-cleanup`; verify end-to-end against a shared inbox.

Integration-tested against real Postgres per `CLAUDE.md`.

## Open questions

- Edit-on-approve: how much payload editing does the inbox allow in v1? (Lean: approve/reject only; edit is phase 2.)
- Per-action-class autonomy vs per-agent for v1 (lean: per-agent dial + per-action risk tag; per-class thresholds phase 2).
- Notification channel default: framework transactional email vs per-client connector (lean: transactional email v1).

## Related

- [/PRD.md](../../PRD.md) · [Architecture v2](2026-06-06-business-os-architecture.md) · [Module SDK](2026-06-09-module-sdk.md)
- Per-user connector scoping (#3) gets its own spec; it adds `owner_user_id` to connectors + per-user agent fan-out and reuses `pending_actions.owner_user_id`.
