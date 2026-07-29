# Per-user Document Parser — zero-touch demo/pilot funnel

**Date:** 2026-07-29
**Status:** BRAINSTORM / exploration — **no code, not approved.** Matt: "I don't do anything yet, just researching, still brainstorming." Do not implement without his explicit go.
**Owner:** Matt + Claude
**Relates to:** [2026-07-25-document-parser-pilot.md](./2026-07-25-document-parser-pilot.md) (the Document Parser module, phase b, shipped) and the pilot-program architecture.

---

## The goal (Matt's words)

A **zero-touch** way to demo/trial the Document Parser (the 20-PDF takeoff extraction) to many concrete-company prospects. "So it can be zero touch for me — just creating them a user." He's weighing **free vs paid** for the trial.

## The key architectural call: this is NOT multi-tenant

Matt first floated "make it multi-tenant." **Multi-tenant is a LOCKED out-of-scope decision** (CLAUDE.md). True multi-tenant means a tenant registry / control-plane DB, request routing by tenant, tenant-scoping every query + storage key + connector + secret, tenant-scoped auth, cross-tenant migrations, billing hooks — a weeks-long rebuild that reopens every locked decision **and breaks the core conversion story** ("the pilot install literally becomes their production install — fee credited, nothing migrated").

Matt agreed to stay off it ("I understand it's not a hard isolation").

## The model instead — per-user scoping in ONE single-tenant install

- **One install** running **only** the Document Parser module. Each prospect = a **user** in that install.
- The module **scopes all data + the doc quota per user** (it already stores `uploaded_by`; the change is filtering every route and counting the cap by user).
- **Unlimited users** (no cap on user count). Per-user **doc quota** (20 default; unlimited on conversion) — reuses the existing `documentLimit` setting, made per-user.
- **You create the users** (invite-email flow) — **not** self-signup (self-service signup stays out of scope / locked).
- Zero-touch: add a user → invite email → they land in their own sandbox.

### Honest tradeoff

All prospects share one DB/deploy — this is **per-user isolation, not hard infrastructure isolation.** Appropriate for a demo/pilot. On real conversion, a prospect **graduates to their own dedicated single-tenant install** which becomes their production. The funnel:

```
shared per-user demo/pilot site  →  dedicated single-tenant install on conversion (= their production)
   (cheap, zero-touch, free or paid)        (the locked "install becomes production" story, preserved)
```

Free vs paid is a **pure funnel toggle** (the quota + whether you charge) — no tech difference.

### Scope of a prospect sandbox

Parse + full-text search index + results view — **all one module** (Document Parser). Keep the **bid-indexer's** heavier projects/matching-rules workflow **out** of a prospect sandbox; the takeoff + search is the clean demo.

---

## The three restructure pieces

**(a) Scope the module per-user — small, but security-critical.**
Every route filters by the logged-in user; the doc cap counts per user. The critical requirement: isolation is enforced **server-side on every route** (a prospect must not be able to pull another prospect's document by guessing an ID) — not merely hidden in the UI.

**(b) User expiration / lifecycle — real design.**
Trial users shouldn't linger forever. Spectrum:
- **Auto-expire:** set a TTL at creation (e.g. 30 days) → a scheduled job disables login at expiry, notifies Matt, and purges after a grace window. Fully hands-off.
- **Remind-me:** a scheduled digest lists users past X days; Matt deletes manually. More control, less automatic.
- **Lean:** soft-expire (disable + notify) + grace period + auto-purge; "extend" = bump the TTL (e.g. on conversion). Hands-off but interruptible.

**(c) Delete-user → wipe ALL their data — a FRAMEWORK concern, the deepest piece.**
Today the framework owns user deletion but doesn't know about a module's tables or its files in object storage (a DB cascade can't delete Tigris objects). Doing this right needs a **new per-user teardown hook**: on user-delete, the framework calls each module's "purge everything for this user" (DB rows **+** storage objects). This is a genuinely useful new primitive — it makes trial cleanup and data-retention hygiene real, and every future per-user module benefits.

Summary: (a) is small; **(b) and (c) are the real work**, and (c) touches the framework, not just the module.

---

## Open questions (asked Matt, awaiting)

1. **Expiry model:** auto-purge on TTL, or remind-you-to-delete?
2. **On conversion:** does the prospect's sandbox data carry into their new dedicated install, or do they re-upload fresh? (Shapes how aggressive auto-delete should be.)
3. Free vs paid for the trial (business call; no tech impact).

## Staying inside the locks

- Not multi-tenant (per-user ≠ per-tenant; one DB, one deploy, no routing/registry).
- No self-service signup (Matt creates users).
- The dedicated-install-on-conversion path preserves single-tenant-per-install and the fee-credited conversion story.
