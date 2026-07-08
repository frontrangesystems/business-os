# Bid Indexer → decompose the monolith into reusable agents

**Status:** Idea / backlog. Captured 2026-07-08 at Matt's request. **No code changed.**
**Owner:** TBD. **Trigger to revisit:** next time we touch bid-indexer, or when a second use-case needs PDF parsing.

## The direction

Today `bid-indexer` is a single **module** (`clients/*/modules/bid-indexer`) that does everything: the upload endpoint + UI pages, PDF → page images, Claude vision OCR, pay-item extraction, and matching-rules linking, plus its own DB tables and background worker.

Matt's steer: the *heavy, generic* pieces of that pipeline should be **agents**, not buried inside one client module — for granularity and reuse. Specifically:

- **PDF parsing / OCR should be its own agent.** This is the high-value one: "PDF → structured text + page layer + OCR of image-only pages" is broadly reusable across clients and future use-cases (not just bids). Matt called this out as "very valuable down the road."
- **Indexing (pay-item extraction) could be an agent** — the step that turns parsed text into structured, linkable items.
- **Matching rules could be an agent** — applying operator-defined rules to link items ↔ pages.

Rough shape: the **module stays** as the thin front (upload route, UI pages, storage, the `projects/bids` tables) and **orchestrates** these agents via events/enqueue, instead of doing the work itself. Agents are the reusable, framework-level units; the module is the client-facing app around them.

## Why this isn't trivial (things to design when we do it)

1. **Modules can't call agents / connectors today.** A module worker gets only `{ settings, logger }` (routes also get `enqueue`) — no connector resolver, no way to invoke an agent. Decomposition needs a clean module→agent handoff (event topic the agent subscribes to, or a module-callable "run agent" hook). See the module context findings in the connector-key work (2026-07-08).
2. **The `llm` connector capability is text-only — no vision.** A reusable PDF-parsing agent that does OCR needs image input. Right now bid-indexer bypasses the connector and uses `@anthropic-ai/sdk` directly for exactly this reason. Prereq (already noted as a FOLLOW-UP in `index-worker.ts`): **extend the `llm` capability with vision/image input** so a parsing agent can go through the connector like everything else. This unblocks both this decomposition AND the "get the key from the connector" work.
3. **Where do the agents live?** If PDF parsing is meant to be reused, it belongs in the shared agent library (`agents/`, a published `@frontrangesystems/business-os-agent-*` package), not in a client tree. Indexing/matching are more bid-specific and might start client-custom.
4. **State + storage boundaries.** Parsed artifacts (page text JSON, page images in Tigris) currently live under the module's `bids/<id>/…` keys. A standalone parsing agent needs a clean input/output contract (where it reads the PDF from, where it writes parsed output) that isn't coupled to bid-indexer's schema.

## Relationship to the in-flight hotfix

Separate and smaller: the approved 2026-07-08 hotfix just makes the *existing* module worker pull its Anthropic **key from the operator-configured connector** (instead of `process.env.ANTHROPIC_API_KEY`, which is unset on prod) and adds a **model-picker setting**. That ships now; this decomposition is the larger "going forward" arc. Note the vision-capability prereq (#2) is shared between the two — solving it properly would also let the hotfix use the connector *capability* rather than reaching for the raw key.
