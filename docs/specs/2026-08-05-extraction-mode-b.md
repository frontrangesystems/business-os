# Extraction Mode B — document-type flexibility for the shared engine

**Date:** 2026-08-05
**Status:** In progress. Phases 1–2 landed.
**Owner:** framework
**Related:** [2026-07-08 bid-indexer decompose](2026-07-08-bid-indexer-decompose-into-agents.md), [2026-07-25 document-parser pilot](2026-07-25-document-parser-pilot.md)

## Why

The extraction engine only knows how to read one shape of document: a published
**schedule of pay-items with quantities** (public/DOT horizontal work). On a
building/commercial bid there is no such schedule — the owner publishes drawings
+ a project manual, and the contractor derives scope from the specs and sheets.
Fed a building set, the engine extracts **zero** items (verified locally on the
mo-barracks plans: 4 sheets, 90–170K chars of concrete/footing/foundation text,
0 items).

This blocks the actual goal: a **product for outreach** to concrete subs who are
not C&M. Different prospects estimate from different documents — DOT subs get
schedules, building subs get narrative specs — so **document-type flexibility is
the product**, and the metric is estimator throughput (more bids out per month).

## Decision

Build the flexibility in the **shared** `@frontrangesystems/business-os-extraction-engine`
(consumed by the `document-parser` module that installs per client), not in
C&M's private `bid-indexer` fork. C&M migrates onto the shared engine (Phase 4).
This completes the long-planned "point the bid-indexer at the shared engine".

Good news from the code audit: the shared engine is **already config-driven** —
prompts are built from an overridable `ExtractionTaxonomy` (domain, page types,
item guidance, `captureQuantity`). "Louisiana DOTD" is only the default constant.
So de-DOT-hardcoding is mostly done; the real gap is mode detection + a second
extraction path.

## Two modes

- **Mode A — schedule.** A populated pay-item schedule exists → extract the rows.
  Unchanged existing behavior.
- **Mode B — narrative.** No schedule → extract scope against a **trade scope
  checklist** (e.g. footings, slab-on-grade, reinforcing, embeds, tilt panels,
  mix design), each finding carrying verbatim evidence. Proven feasible: a $0.08
  probe over the mo-barracks structural sheets pulled 12/20 concrete checklist
  items with real verbatim evidence, where the current engine got 0.

The discriminator is the field's rule: a genuine schedule has a column of
**populated numeric quantities**; a unit-price/change-order form has item + unit
but no quantities and must NOT anchor as the scope of work.

## Plan

- **Phase 1 — doc-shape detector. ✅ Done.** `detectDocumentShape()` in the
  engine decides `schedule` vs `narrative` deterministically from the items +
  page types already produced — no extra LLM call. Surfaced on
  `ParseResult.shape` and logged. Unit-tested (7 cases incl. the mo-barracks
  unit-price-form case → narrative).
- **Phase 2 — Mode B extraction path. ✅ Done.** Engine side (commit `4f0fa76`):
  `extractScope()` + `scopePrompt`/`scopeChecklist` on the taxonomy, a
  `ScopeResult` type (checklist item + present/uncertain + capped verbatim
  citations), checklist-as-ground-truth (invented items dropped). Module side:
  a `document_parser_scope_findings` table (migration `0002`, JSON citations) +
  a `shape` column on documents; the parse worker now branches on
  `result.shape` — narrative docs run `extractScope` over the page text
  `parseDocument` already produced (no re-OCR) and persist findings, schedule
  docs are unchanged; scope cost is folded into the document's `costUsd`.
  Findings surface on `GET /documents/:id`. The checklist + optional guidance
  are per-install settings with a concrete-trade default (this also lands the
  Phase 3 checklist knob early). Integration-tested against real Postgres. UI
  to render findings is still to do.
- **Phase 3 — config.** Trade + scope checklist per-install settings **landed
  in Phase 2** (`scopeChecklist` + `scopeGuidance`, concrete-trade default,
  single checklist per install). Remaining: multi-trade selectable, and expose
  `metaGuidance` (currently the one non-configurable taxonomy field).
- **Phase 4 — migrate C&M.** Point the C&M bid-indexer at the shared engine and
  port its stronger multi-page ref-linking (where the ref-threshold "D1" fix
  lands), behind a byte-identical regression gate on the DOT set so C&M's output
  does not move.

## Defects folded in (from the mo-barracks findings report)

- **D1 (junk page refs)** — the C&M fork's ref linker over-matches on weak
  keyword overlap and hard-caps at 5. Fixed when the linker moves to the shared
  engine in Phase 4 (tighten the link threshold; drop the arbitrary cap).
- **D2 (missed building scope)** — this whole spec (Modes + Phase 2).
- **D3 (doc type from upload slot)** — classify from content (page-type mix),
  not the upload query-param. Small; addressed as the shared engine grows a
  document-level type.

## Verification

Local harness runs the engine against a PDF on disk (no DB/boot). Corpus:
mo-barracks plans (narrative/Mode B) + the C&M DOT set (schedule/Mode A). The
Anthropic key resolves from the dev-DB `connector:llm` secret, never in files.
