# Document Parser — pilot product + shared extraction engine

**Date:** 2026-07-25 (decisions locked + phase (a) landed 2026-07-27)
**Status:** Approved. **Phase (a) — the extraction-engine library — is built + tested** (`packages/extraction-engine`). Phases (b)–(d) pending.
**Owner:** Matt + Claude
**Refines:** [2026-07-08-bid-indexer-decompose-into-agents.md](./2026-07-08-bid-indexer-decompose-into-agents.md) — concretizes the "pull the reusable parsing engine out of bid-indexer" direction, but as a shared **library** consumed by a standalone **module**, not as an agent (see §9).

---

## Context

Matt is standing up a **paid pilot program** for concrete companies (like C&M). The pilot is a proof-of-concept: a prospect uploads their **own** plan sets + specs and sees the **takeoff / pay-item extraction** working on their real documents — de-risking the full build, because every company's documents differ. Constraints from Matt:

- **20 documents** max per pilot.
- **Paid.** If the prospect converts to the full Business OS, the pilot fee is **credited** toward it.
- Reuse the PDF-parsing/extraction we already built for C&M's bid-indexer — but **only** the parsing/extraction, none of the bid-workflow (projects, match rules, bid matching).
- "Clean it up and put it in the core, as a separate module altogether, **no dependencies on any outside modules or agents.**"
- Must support **custom logic per concrete company.**
- "I don't want to move faster, I want to make sure we're doing it **right**."

## Goals

1. Extract the reusable parsing/extraction engine out of C&M's bid-indexer into **one shared library** ("one brain," no fork).
2. Build a slim, standalone **Document Parser** module (the pilot product) on top of that engine, with a **20-document cap** setting.
3. Deliver each pilot as a **per-pilot single-tenant install** that grows into the full engagement (no migration, fee credited).
4. Make **per-company customization** a first-class design concern (config → client-custom code → engine seams).

## Non-goals

- No multi-tenant / shared pilot site. (Locked decision: single-tenant per install. The pilot install *is* the seed of the full install.)
- No bid-workflow in the pilot (projects, match rules, pay-item↔page matching, bid FTS-as-product stay in C&M's bid-indexer).
- No self-service signup / provisioning UI.

---

## Architecture — three layers

```
┌─────────────────────────────────────────────────────────────┐
│  extraction-engine   (LIBRARY, framework-level — the brain)  │
│  PDF on disk + vision-LLM client + taxonomy/config           │
│      → structured { documents, pages, pay-items, cost }      │
│  No DB. No object storage. No module/agent imports.          │
└─────────────────────────────────────────────────────────────┘
        ▲                                   ▲
        │ imports                           │ imports (later — §8)
┌───────────────────────────┐      ┌────────────────────────────┐
│  Document Parser (MODULE)  │      │  C&M bid-indexer (MODULE)   │
│  monorepo, shared, like    │      │  client-custom, C&M repo    │
│  prospector. Upload + view │      │  drops its private copy of  │
│  + export + 20-doc cap.    │      │  the engine, keeps bid      │
│  Deps: module-sdk + engine │      │  workflow on top.           │
└───────────────────────────┘      └────────────────────────────┘
```

**The key distinction (resolves "no dependencies on outside modules or agents"):** the shared engine is a **library** — the same category as the SDKs every module already depends on — **not** a module and **not** an agent. The framework boundary rule forbids a module importing another *module* or *agent*; a library dependency is normal and required. The Document Parser module will import only `@frontrangesystems/business-os-module-sdk` + the engine library. It will never import bid-indexer or any agent.

---

## Layer 1 — the extraction engine (shared library)

**Good news from the code audit:** the engine is *already* factored for this. `index-worker.ts` has an explicit seam at line 914 (`// ----- core indexer (no DB / no Tigris — reusable + testable) -----`). `buildIndex()` (line 947) already takes an in-memory `BuildIndexInput` and returns a `BuildIndexResult` with **zero** DB/Tigris/schema references. The lift is real, but the author designed for it.

**New package:** `@frontrangesystems/business-os-extraction-engine` (name TBD — see Open Decisions). A plain library package in the monorepo (e.g. `packages/extraction-engine/`), not a module/agent.

**What lifts in (the pure region, `index-worker.ts` lines 1–~1168 minus the two DB helpers):**
- PDF → page render + dims (`pdfinfo`, `pdftoppm` via `poppler-utils`).
- Text-layer vs image-only page classification (`pdftotext -layout`, `TEXT_THRESHOLD`).
- Vision OCR of image-only pages (Claude vision, tiling for oversized sheets).
- Text extraction for text-layer pages (cheap text-only Claude call).
- Pay-item collection + dedup.
- Cost accounting (input/output tokens × price).

**Engine interface (conceptual):**
```
parseDocument(input: {
  pdfPath: string;              // PDF already on local disk
  tmpDir: string;
  vision: VisionLlmClient;      // abstracted (default: Anthropic) — see §9
  model: string;               // passed IN (fix the mutable module-global, below)
  pricing: { in: number; out: number };
  taxonomy: ExtractionTaxonomy; // prompts + page-type set + item field spec (per-company)
  tuning?: EngineTuning;        // DPI, concurrency, thresholds — sane defaults
  logger: Logger;
}): Promise<ParseResult>        // { pages[], items[], pageCount, costUsd, tokens }
```

**Three fixes/changes made during extraction (all improvements, not just a move):**
1. **Model + pricing become inputs**, not the mutable module-level globals (`let MODEL/PRICE_IN/PRICE_OUT`, lines 74–79) that `indexBidHandler` mutates per job. That global is the one real anti-pattern in the current code (concurrent jobs share it); passing them in removes it.
2. **Prompts / taxonomy become config, not hardcoded.** Today the prompts bake in "Louisiana DOTD construction bid" and a fixed `page_type` enum (lines 107–135). These become an `ExtractionTaxonomy` input: prompt template + allowed page types + the pay-item field spec. **This is the seam that makes per-company customization possible** (§7).
3. **Add quantity capture.** ⚠️ The current engine extracts only `{ description, item_code, unit }` — **quantity is NOT captured**, even though the prompt references it. For a **takeoff** product, quantity is the point. The engine's item shape becomes `{ description, itemCode, unit, quantity? }` and the prompt asks for it. (Open Decision — confirm.)

**Dependencies:** `@anthropic-ai/sdk`, `zod`. **Plus a system dependency: `poppler-utils`** (`pdfinfo`, `pdftoppm`, `pdftotext`) must be in the runtime image — it already is in C&M's Docker image; the pilot scaffold's Dockerfile must include it too.

**Stays behind (bid-indexer keeps it):** the matching-rules layer (`bidIndexerMatchRules`, `findRefsForItem`, ref-linking) is bid-indexer's operator-training feature, not generic extraction. It can travel later as an *optional* pluggable ref-computation strategy, but it is **not** in the pilot.

---

## Layer 2 — the Document Parser module (the pilot product)

A standalone shared module in the monorepo (`modules/document-parser/`), modeled on `prospector`. Depends only on `module-sdk` + the engine library.

**Own schema (its own migrations, no bid-workflow tables):**
- `document_parser_documents` — one row per uploaded PDF: `id, original_filename, storage_key, status (uploaded|parsing|parsed|failed), page_count, content_hash, title, uploaded_by, uploaded_at, parsed_at, result_json, error`.
- `document_parser_items` — extracted pay-items: `id, document_id, description, item_code, unit, quantity, page_no`.
- (Optional) `document_parser_pages` — page text for search/preview, if we want search in the pilot.

Explicitly **no** `projects`, `match_rules`, `doc_order`, bid-matching, or bid FTS-as-a-feature.

**Reuses:** the upload route pattern + `@fastify/multipart` handling + the generic Tigris `storage.ts` (it's already provider-generic — just drop the bid-specific key prefixes; keys become `documents/<id>/original.pdf` etc.). Consider lifting `storage.ts` into the engine library or a small shared storage util so both modules share it too.

**Settings (auto-rendered form):**
- `model` — Claude model for extraction (reuse the existing model picker + pricing).
- `documentLimit` — number, default **20** (the pilot cap; `0`/unset = unlimited for full installs).
- **`extractionTaxonomy`** fields — the per-company customization (company profile / what pay-items & units they care about / jurisdiction terminology / extraction guidance), as free-text settings the engine reads. Same pattern as the prospector rubric-in-settings. Long fields use `.max(>200)` so they render as textareas (zod-form convention, `packages/core/src/zod-form.ts:117`).

**Upload flow + cap enforcement:** on upload, count `document_parser_documents` rows; if `>= documentLimit`, reject with a clear "Pilot limit reached (20/20) — upgrade to add more." Otherwise store to Tigris → insert row (`uploaded`) → enqueue a parse job → engine runs → persist items + `parsed`.

**UI (slim):** Upload; document list with status; per-document view of extracted takeoff/pay-items (description / code / unit / quantity / page); export (CSV of the takeoff). No projects, no matching UI.

---

## Layer 3 — delivery (per-pilot install)

- Each paying pilot = its own single-tenant install, scaffolded via the existing `create-client` tool (`tools/create-client`, real + tested).
- A **"pilot" config profile**: `business-os.config.ts` registers only the Document Parser module; settings set `documentLimit: 20` + the company's extraction taxonomy.
- Dockerfile includes `poppler-utils` + a Tigris bucket per install (as C&M already has).
- **Conversion path:** because it's single-tenant, converting to the full Business OS = in the *same* install, lift `documentLimit` and switch on the other modules/agents. Their parsed documents are already there; nothing is migrated or thrown away; the fee is credited. **The pilot install literally becomes their production install.**
- A separate **seeded demo site** (single-tenant, sample concrete data) is the sales tool used to *sell* the pilot — distinct from delivery.

---

## §7 — Per-company custom logic (first-class)

Matt asked explicitly: does this enable custom logic per company? **Yes**, and better than a fork. Shared engine = shared *code*, not identical *behavior*; behavior is parameterized by per-company inputs. Three levels, cheapest first:

1. **Settings (most companies, zero code).** The company's pay-item taxonomy, units they care about, jurisdiction terminology, and extraction guidance live in *their* settings; the engine reads them via the `ExtractionTaxonomy` input. Company A wants curb-and-gutter LF + concrete CY; Company B is asphalt tonnage — same engine, different config. This is also where "every document is a little different" is absorbed: the engine is LLM-vision (adapts per document) and settings steer what it looks for.
2. **Client-custom code in their own install (the ~10% config can't cover).** Single-tenant means their deployment is theirs to extend: a client-custom module/post-processor in *their* repo can wrap or post-process the engine's output for a bespoke workflow — without touching the shared engine or affecting anyone else. (Framework rule: shared code stays generic; client-custom code lives in the client's install.)
3. **Engine seams.** The engine takes taxonomy/rules as **input** and exposes hooks (e.g. a post-extraction transform), so customization plugs in rather than requiring edits to engine internals. Extension points are designed in, not bolted on.

---

## §8 — C&M bid-indexer migration (trails the pilot)

Once the engine library is proven by the pilot, refactor C&M's `bid-indexer` worker to call the shared engine instead of its private copy — deleting the duplicated pure region and keeping only the bid-workflow shell (projects, match rules, ref-linking, FTS, status). This is what makes it truly "one brain." It is **not** required to ship the pilot; it de-duplicates afterward. bid-indexer stays a client-custom module in C&M's repo; it just depends on the shared engine library (a library, not a module — boundary respected).

---

## §9 — Design decisions & rationale

- **Library, not agent.** The 07-08 spec imagined PDF-parsing as an *agent*. A library is cleaner here and sidesteps both blockers that spec flagged: (1) "modules can't call agents" — irrelevant, the module calls the library in-process; (2) "llm connector is text-only, no vision" — irrelevant, the engine uses a vision-LLM client (Anthropic) directly, as bid-indexer already does. A vision *connector capability* remains a nice future abstraction but is **not** a blocker.
- **Vision client abstraction.** Define a minimal `VisionLlmClient` interface the engine depends on (default impl wraps `@anthropic-ai/sdk`), so the engine isn't hardwired to one provider and is unit-testable with a fake.
- **Single-tenant reaffirmed.** Paid + real client documents make isolation *more* important, and the pilot-install-becomes-production story only works single-tenant.

---

## Phased plan

- **(a) Extract the engine.** New `packages/extraction-engine` library: lift `buildIndex` + pure helpers; make model/pricing/taxonomy inputs; add the `VisionLlmClient` abstraction; add quantity capture; unit tests with a fake vision client + a small fixture PDF. Prove parity against C&M's current output.
- **(b) Build the Document Parser module.** `modules/document-parser`: schema + migrations, upload route + storage, parse worker calling the engine, settings (model + documentLimit + taxonomy), slim UI, CSV export.
- **(c) Cap + pilot scaffold.** Enforce `documentLimit` at upload; add a "pilot" profile to `create-client` (Document Parser only, cap 20, poppler in Dockerfile, per-install bucket).
- **(d) De-dup C&M (trails).** Point bid-indexer at the shared engine; delete its private copy.

Ship order for a paying pilot: (a) → (b) → (c). (d) follows.

---

## Decisions — LOCKED 2026-07-27 (Matt)

1. **Quantity extraction — YES, with override.** The engine now captures `quantity`. The consuming module stores **two columns**: `quantity_extracted` (what the model read, immutable) + `quantity` (the effective value, defaults to extracted, operator-editable inline; edits audit-logged). Provenance kept so operators can see when the AI was off and spot when extraction needs tuning.
2. **Package name = `@frontrangesystems/business-os-extraction-engine`.**
3. **Search — IN.** Cheap (page-text table + DB query); include `document_parser_pages` + search in the pilot.
4. **Export — simple CSV.** A download of the extracted takeoff (description / item_code / unit / quantity, one row per pay-item). It's how estimators get the data into their own tools; cheap and high-value. Not tied to a specific estimating-tool import format for the pilot.
5. **Document limit — `documentLimit` setting, default `0` (unlimited).** The pilot install profile sets it to 20. Full/C&M installs leave it unlimited.

### C&M bonus (noted)
Because the Document Parser is a **shared** module in the monorepo, C&M can enable it directly and get upload/extract/quantity/search/export for free. The engine's quantity work also reaches C&M's bid-indexer for free once phase (d) points it at the shared engine. Adding the CSV export *inside* bid-indexer's own screens is a small optional extra.

## Phase (a) — as built (2026-07-27)

`packages/extraction-engine` (library, no DB/storage/framework coupling). Public API: `parseDocument()`, `extractMeta()`, `createAnthropicVisionClient()`, `CONSTRUCTION_BID_TAXONOMY`, `OPUS_4_8_PRICING`, plus `VisionLlmClient` / `ExtractionTaxonomy` / `EngineTuning` types.
- **Model + pricing are inputs** (no mutable module globals — the one real anti-pattern in the old code is gone).
- **Prompts are taxonomy-driven** (`ExtractionTaxonomy`): domain description, page-type set, item guidance, `captureQuantity`. This is the per-company seam.
- **`VisionLlmClient` abstraction** — default wraps `@anthropic-ai/sdk` (retry + oversize detection); tests inject a fake.
- **Quantity captured** on every item (`{ description, itemCode, unit, quantity, sourcePage }`).
- **Ref/match-rule linking stays out** — the engine returns items + page text; the module links (bid-indexer keeps its rules layer).
- Tests: 22 passing — pure-helper units + a real-poppler integration test (fake vision client) covering the text-layer path, the image-only/vision path, tiling of oversized pages, dedup, cost math, and meta extraction.

Parity against C&M's live output is validated when phase (d) wires bid-indexer to the engine.
