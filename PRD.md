# Business OS — Product Requirements

**Date:** 2026-06-06
**Status:** Active
**Supersedes:** [docs/archive/2026-05-multi-tenant-original/prd/](docs/archive/2026-05-multi-tenant-original/prd/)

---

## What this is

A framework and a library of pluggable agents that Matt's team installs once per client as a custom operating system. Every client gets their own deployment, their own database, their own infrastructure.

Not a SaaS. Not multi-tenant. Each engagement is a high-ticket professional services build (target: $500K+) where the client owns the outcome and we own the speed of delivery.

The reference architecture (Lior Krolewicz's Master Key OS) proved buyers will pay this level for a real business OS that absorbs the messy work their people do today. We're building independently, not as a Master Key implementer. The category is real and competitive — e.g. James Black Consulting's ["AI OS Install"](https://jamesblackconsulting.com/ai-os-install) sells the same outcome (a per-client OS that "removes the founder as the bottleneck"). The consistent takeaway: the value isn't the automations, it's a trustworthy *decision layer* — agents that act with the human kept in control.

## Why

Three things are true at once:

1. Mid-market COOs and CEOs are buying outcomes, not seats. They want fewer hands and more leverage. AI makes that possible for the first time.
2. Building each client's stack from scratch every time is bankrupting margin and timeline. The work *should* compound across engagements.
3. SaaS economics don't fit the buyer. $500K once, plus a maintenance/retainer relationship, beats $2K/mo for software they only half-trust with their data.

A framework + agent library says yes to all three. We deliver custom builds, but we don't re-invent the chassis each time.

## Who it's for

**Buyer:** COO or CEO at a $10M–$50M operator-style business (construction, distribution, professional services, healthcare ops). They run a tight team, they're behind on automation, and they have specific revenue or cost outcomes they want a system to absorb.

**First client:** C&M Construction (concrete). The build there proves the model.

**Not for:**
- VC-backed software companies who want to build it themselves.
- Sub-$10M businesses who can't fund a $500K engagement.
- Anyone shopping for a SaaS subscription.

## The offering

Each engagement delivers:

1. **A deployed Business OS instance**, single-tenant, in the client's chosen infrastructure (their cloud or ours).
2. **An enabled set of agents** chosen from the shared library to match their operating reality (Lead Gen, Prospecting, LinkedIn, Instagram, Email Triage, Pipeline Manager, etc.).
3. **Custom agents** built specifically for the client where the shared library doesn't fit.
4. **Operator UI** for their team to run the system day to day — connect accounts, configure agents, review what the agents did, intervene when needed.
5. **Connector setup** to their existing systems (Gmail, GHL, HubSpot, Slack, their CRM, their LLM provider of choice).
6. **A maintenance/retainer** path after go-live — bug fixes, framework upgrades, new agents as their business evolves.

The artifact the *client* receives is their installed system. The artifact *we* own and reuse across engagements is the framework + agent library.

## What the framework does

- Boots a Fastify API + worker process on their infrastructure.
- Owns auth (sessions, Argon2id, optional TOTP), audit log, settings storage, secrets encryption.
- Provides the agent runtime: schedule agents, give each agent a typed context (logger, DB, connectors, settings), run them.
- Resolves connectors by capability so agents don't hard-code providers. Operator picks Gmail or Outlook for `email`; agents don't care.
- Renders settings forms automatically from each agent's Zod schema — no per-agent UI work to expose new knobs.
- Runs migrations forward (framework core + each enabled agent) on boot.

## What an agent does

Each agent is a focused, named piece of work the system performs on the operator's behalf:

- **Lead Gen** — finds prospects matching the ICP, pushes into CRM with enrichment.
- **Prospecting** — researches a specific company, writes a first-touch outreach draft.
- **LinkedIn** — drafts posts in the operator's voice from raw inputs, schedules them.
- **Instagram** — same for IG, plus carousel generation.
- **Email Triage** — categorizes inbound, drafts replies, flags what needs human eyes.
- **Pipeline Manager** — keeps CRM stages honest, surfaces stale deals, drafts follow-ups.

The list grows. Each agent is one published npm package. Adding a new shared agent means one new package, not a framework change.

## What an operator does day to day

1. Logs into the operator UI (their subdomain, their auth).
2. Sees the list of agents running on their instance.
3. Configures or tunes each one: schedule, settings, which connector is active.
4. Reviews recent agent runs — what was done, what was attempted, what needs review.
5. Approves or rejects draft outputs where the agent is set to "draft + approve" mode.
6. Adds new connector credentials when they bring on a new tool.

Nothing they do requires touching code, redeploying, or editing config files. That rule is load-bearing.

## Distribution model

**Hybrid A+B:**

- **A. Starter shell** — a thin per-client repo scaffolded once via `pnpm create business-os-client <slug>`. Contains config, env, deploy artifacts, and a place for client-custom agents. Nothing more.
- **B. Versioned packages** — `@frontrangesystems/business-os-*` published to a private npm registry. Framework, runtime, SDKs, shared agents, shared connectors. Upgrades flow via `pnpm up`.

Why hybrid: pure starter-template means every framework upgrade is a per-client merge job. Pure packages means there's no client repo at all. Hybrid means we scaffold the entry point once and put the meat behind versions. This is the same pattern Next.js and Vite use.

## Constraints

- **No multi-tenancy. Ever.** This isn't a SaaS. Don't reintroduce tenant routing, control-plane DB, or shared infrastructure across clients.
- **No public marketplace.** Agents are built or curated by us. Third parties don't ship agents into client installs.
- **No visual workflow builder.** Agents are code. The operator UI configures them, doesn't draw them.
- **No low-code.** Same reason.
- **No self-service signup.** Engagements start with a sales conversation, end with a deployed instance.
- **Runtime config goes in the DB, not files.** Credentials, schedules, on/off, per-agent settings live in the settings UI. Files only declare what's installed.

## What we're building next — the decision layer

The framework today runs agents and records what they did. The capability that turns that into a system a client trusts to act on their behalf — and the one the whole category sells — is the **decision layer**: agents propose, humans approve, agents proceed. Priority order:

1. **Human-in-the-loop approval inbox (P0).** An agent proposes an action (send this email, submit this) → it lands in an operator inbox → a human approves, edits, or rejects → the agent proceeds. Audited end to end. This is the missing primitive behind the "draft + approve" mode the operator section already promises; without it no client trusts an agent to touch a customer. It's the difference between this product and a cron job.
2. **End-to-end workflow orchestration (P1).** Chain agents + connectors + an approval gate into one live workflow with shared state and a whole-flow view. Code-defined — never a visual builder (see Constraints).
3. **Notifications / escalations (P1).** An agent reaches a human (email/Slack/SMS) when it needs input or hits a milestone. An approval inbox nobody is pinged about is useless.
4. **Cross-agent activity feed (P2).** One place to answer "what did the OS do this week, and what's waiting on me." Builds on the per-agent run history we already have.

First proof: take **Lead Gen** fully end-to-end — trigger → enrich → draft outreach → human approves in the inbox → send → log. That single workflow forces these primitives into existence and is the demo that sells the install.

## Success criteria

**For the framework itself:**

- A second client install can stand up in days, not weeks, with no framework changes.
- A framework bug fix rolls out to N live clients with `pnpm up` and a redeploy. No per-client patches.
- A new shared agent ships as one package, gets adopted by any client with a config line and a settings UI visit.
- A client can run for 90 days without a framework engineer touching their instance.

**For the first install (C&M Construction):**

- Lead Gen agent is running on real C&M data, pushing real leads into their CRM, on a schedule, by [date TBD].
- Their operator UI is the only place they need to configure or check the system.
- The system survives the first month without framework patches required for stability.

## Out of scope (for now)

- Native mobile app — PWA covers it.
- SSO, SAML, social login, magic links — sessions + optional TOTP is enough.
- In-platform billing — we invoice outside the system.
- Multi-region deployment — single region per client.
- A separate Master Key implementer relationship — we may license parts of Master Key later, but the architectural decisions here are independent.

## Open questions (resolve before deeper coding)

- npm registry: GitHub Packages under which org?
- Deploy target for C&M: Fly.io, Render, bare VM, their cloud?
- First LLM connector: Anthropic, OpenAI, or both?
- Operator UI hosting: served by the same Fastify process, or separate Vite app behind same auth?
- Pricing structure: fixed-fee build + monthly retainer, or fixed-fee build + per-agent licensing?

## Related documents

- [Architecture spec](../specs/2026-06-06-business-os-architecture.md) — the technical "how"
- [/CLAUDE.md](../../CLAUDE.md) — locked decisions and conventions
- [Archived multi-tenant docs](../archive/2026-05-multi-tenant-original/) — what we chose NOT to build
