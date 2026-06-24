# PRD — Business OS

**Status:** Active (current). **Date:** 2026-06-24.
**Supersedes:** the 2026-05-19 framework + client PRDs in `docs/archive/2026-05-multi-tenant-original/` (those assumed a multi-tenant control plane we have since abandoned for single-tenant-per-install — see [Architecture v2](../specs/2026-06-06-business-os-architecture.md) and the locked decisions in `CLAUDE.md`).

This PRD is the product-level companion to the technical specs in `docs/specs/`. It states *what* we are building and *why*, and the prioritized roadmap. It does not re-litigate the locked technical decisions in `CLAUDE.md`.

---

## 1. Problem

Small-to-mid businesses buy AI tools and never get leverage from them: the tools sit unused because nothing ties them to how the business actually runs. The deeper problem is that **the founder/operator is the bottleneck** — every decision, handoff, and approval routes back through one person, so the company's throughput is capped by that person's capacity.

Generic SaaS doesn't fix this: it gives the business another tool to operate, not a system that operates *for* them. What's needed is a custom operating system, installed once per business, that absorbs recurring work and lets the team execute without routing every call back through the founder.

## 2. Product vision — the bottleneck thesis

**Business OS is a custom operating system we install once per client** to remove the founder as the bottleneck: a "digital brain + decision layer + automation stack" wired to how that specific business operates. It is a high-ticket professional-services build ($500K+ engagements), not a SaaS — one deployment, one database, one repo per client. First client: **C&M Construction** (concrete).

The product is a **framework + a library of pluggable agents and connectors** (versioned `@frontrangesystems/business-os-*` packages) plus a thin per-client shell scaffolded once (Hybrid A+B). Agents do the recurring work; connectors give them the business's tools; the operator configures everything at runtime in a settings UI.

### Competitive / reference context

This is a real and validated category. Comparable offerings frame the same outcome:

- **James Black Consulting — "AI OS Install"** (https://jamesblackconsulting.com/ai-os-install): a 30-day engagement that "removes the founder as the bottleneck." Five deliverables — Diagnosis (the single highest-cost bottleneck) → Custom Operating System ("digital brain, decision layer, automation stack") → **one live workflow** end-to-end → **AI Delegation Stack** ("your team executes without routing every call back through you") → Handoff (docs, training, playbooks). Application-only founding cohort.
- **Lior Krolewicz — Master Key OS** (workshop, 2026-06-05): the original inspiration; reference architecture, not a co-author. We build independently.

The takeaway that drives our roadmap: across the category, the product's value is a **trustworthy delegation/decision layer** — agents that act, with the human kept in control. That is the capability we must nail.

## 3. Target users

- **Operator (primary): Front Range Systems / Matt.** Installs and runs the OS for the client. Lives in the settings UI, the agent/connector config, and the activity/approvals surfaces. Cares about: getting an agent live fast, trusting it in production, and handing off cleanly.
- **Client admin (secondary):** a designated person at the client (e.g. C&M estimator/owner). Approves agent actions, reviews outcomes, manages users.
- **Client end-users (tertiary):** staff who consume agent output (e.g. an indexed bid, a drafted outreach) inside the operator UI.

## 4. What exists today (built)

- **Core** (`packages/core`): Fastify server; server-side sessions + httpOnly cookies; Argon2id passwords; optional TOTP MFA; users + roles (admin/estimator); audit log on state-changing actions; runtime settings UI (auto-rendered from each agent's Zod schema); structured Pino logging (`client_slug`/`request_id`/`user_id`/`agent_slug`); Sentry.
- **Runtime** (`packages/runtime`): agent manifest + `run(ctx, input)` contract; scheduler (cron / manual / event); connector resolution by capability; background jobs on pg-boss; **per-agent run history** (`agent_runs` table) surfaced in an Agent Detail UI with a run-details renderer.
- **Connectors:** capability-based, pluggable providers; auto-registered via `connectors-all`; operator chooses visible providers on a Providers admin page; **Composio** is the default integration backbone (direct only for protocol-level / unsupported / IT-restricted cases).
- **Modules / agents:** module SDK (`packages/module-sdk`); shared agent library (leadgen, prospecting, etc.); client modules — **bid-indexer** (C&M: OCR-indexes bid PDFs, links pay-items to pages, operator-trainable matching rules, now **projects grouping multiple PDFs + project-scoped full-text search**), **bid-watcher**.
- **Delivery:** per-client scaffolder (`create-business-os-client`), forward-only migrations (core + per-agent), per-client Fly deploy with a pre-cutover migration step.
- **In-flight specs:** cost visibility, dashboard & digest, account-shaped connectors, module SDK, UX audit (see `docs/specs/`).

What we have is a solid **automation stack** (agents that run and record outcomes) and the **operator surface** to configure it. What we do **not** have yet is the **decision layer** — the piece that makes delegation trustworthy.

## 5. Core feature roadmap

The gap between "a pile of scheduled agents" and "an OS that removes the founder bottleneck" is the decision layer. These are the core features to build, in priority order.

### 5.1 — Human-in-the-loop approval inbox (P0, the decision layer)

The missing primitive. An agent **proposes an action** (send this email, submit this, charge this) → it lands in an **operator/admin inbox** → a human **approves / edits / rejects** → the agent proceeds (or doesn't). Every decision is audited.

Why P0: today agents just run and log an outcome; there is no "draft it, let me approve, then act." No client will trust an agent to contact a customer or submit anything without this. It is the difference between our product and a cron job, and it is precisely the "execute without routing every call back through you, *but keep control*" capability the category sells.

Shape (to be specified): a pending-actions data model; an agent-SDK hook (`ctx.requestApproval(...)` that suspends the run/step until resolved); an operator UI inbox; audit + notification on every transition.

### 5.2 — End-to-end workflow orchestration (P1)

Chain agents + connectors + an approval step into **one live workflow** with shared state and a whole-flow run view (not just one agent's run). **Code-defined, not a low-code/visual builder** (the builder is locked out of scope). Today agents are islands triggered by schedule/event; a real bottleneck-removing workflow spans several steps and at least one human gate.

### 5.3 — Notifications / escalations (P1)

Agent → human (email / Slack / SMS) when input is needed or a milestone is hit. Pairs with 5.1: an approval inbox nobody is pinged about is useless. Distinct from the framework's transactional system email; routed via connectors where possible.

### 5.4 — Cross-agent activity feed / rollup (P2)

"What did the OS do this week" — a rollup across agents for operator trust and the client handoff. We have per-agent history; a unified feed + digest builds on the in-flight dashboard-and-digest spec. Not urgent.

### First proof point

Prove 5.1–5.3 by taking **one agent (Lead Gen) fully end-to-end**: trigger → enrich → draft outreach → **human approves in the inbox** → send → log. This single workflow forces the approval, orchestration, and notification primitives into existence and becomes the demo that sells the install. (Matches the `CLAUDE.md` directive to build one agent end-to-end and let it pull the framework into shape.)

## 6. Scope & non-goals

**In scope (now):** the decision-layer roadmap above, on top of the existing single-tenant framework + agent/connector library + per-client shell.

**Out of scope / non-goals** (from `CLAUDE.md`, do not build unless asked): multi-tenant routing / control plane; self-service signup or client-provisioning UI; in-platform billing; public agent marketplace; **visual/low-code workflow builder**; native mobile app (PWA covers it); SSO/SAML, social login, magic links (TOTP MFA is enough).

## 7. Locked decisions

See the **Locked technical decisions** table in `CLAUDE.md` and [Architecture v2](../specs/2026-06-06-business-os-architecture.md) — single-tenant per install; Hybrid A+B distribution; GitHub Packages registry; Fastify + Zod + OpenAPI; pnpm + Turborepo; Drizzle; server-side sessions + Argon2id + optional TOTP; libsodium-encrypted secrets; pg-boss jobs; Pino + Sentry; forward-only migrations; Vitest against real Postgres; TS strict / ESM. Do not re-litigate without explicit approval.

## 8. Success metrics

- **Time-to-live for an agent:** operator can configure + activate a shared agent for a client in < 1 day, no code change.
- **Delegation adoption:** % of agent-proposed actions resolved through the approval inbox (vs. agents that can only observe). Target: the flagship workflow (Lead Gen) runs end-to-end with a human gate in production.
- **Bottleneck removed:** at least one recurring founder task at C&M fully delegated through an approved workflow.
- **Trust:** operator can answer "what did the OS do and what's awaiting me?" from one surface.

## 9. Risks

- **Trust before capability:** if the approval/decision layer feels heavier than doing the task manually, operators bypass it. Mitigation: make the inbox fast; default low-risk actions to auto-approve with policy.
- **Orchestration sprawl:** code-defined workflows can grow into an ad-hoc engine. Mitigation: keep workflows thin; resist the locked-out low-code builder.
- **Scope creep per client:** adjacent "nice" features crowd out what the client actually bought (see bid-indexer — client wanted indexing; estimating features deferred). Mitigation: build the requested capability, defer the rest.
- **Single-operator dependency:** the operator (FRS) is itself a bottleneck across installs. Mitigation: the handoff protocol + activity rollups.

## 10. Open questions

- Approval inbox: per-action vs per-workflow-step granularity? Policy model for auto-approve thresholds?
- Orchestration: extend the event system, or introduce an explicit workflow/state primitive in the runtime?
- Notifications: reuse per-client connectors (Slack/email) vs a dedicated framework notification channel?
- Does the decision layer get green-lit next, or does client-specific work take priority? (As of 2026-06-24 the roadmap above is proposed; building the approval inbox is **not yet approved**.)

## 11. Related documents

- `CLAUDE.md` — durable conventions + locked decisions.
- [Architecture v2](../specs/2026-06-06-business-os-architecture.md)
- [Integration platform (Composio)](../specs/2026-06-08-integration-platform.md)
- [Module SDK](../specs/2026-06-09-module-sdk.md)
- [Account-shaped connectors](../specs/2026-06-09-account-shaped-connectors.md)
- [Cost visibility](../specs/2026-06-09-cost-visibility.md)
- [Dashboard & digest](../specs/2026-06-11-dashboard-and-digest.md)
- Archived (superseded): `docs/archive/2026-05-multi-tenant-original/prd/`
