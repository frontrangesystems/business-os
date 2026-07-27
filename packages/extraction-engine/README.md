# @frontrangesystems/business-os-extraction-engine

Reusable **PDF → takeoff / pay-item extraction** engine. Renders pages, OCRs
image-only sheets with a vision LLM, extracts structured pay-items (with
quantity), and reports cost.

**It is a pure library** — no DB, no object storage, no framework/module/agent
coupling. The only I/O is a PDF on local disk plus an injected vision-LLM
client. The consuming module (the shared **Document Parser** module, or C&M's
client-custom **bid-indexer**) owns upload/storage, persistence, and any
ref/match-rule linking. This engine owns the expensive, reusable brain — one
brain shared across every client.

See `docs/specs/2026-07-25-document-parser-pilot.md` for the design.

## System dependency

Requires **poppler-utils** (`pdfinfo`, `pdftoppm`, `pdftotext`) on the runtime
`PATH`. Add it to the deploy image (C&M's Docker image already has it).

## Usage

```ts
import {
  parseDocument,
  createAnthropicVisionClient,
  CONSTRUCTION_BID_TAXONOMY,
  OPUS_4_8_PRICING,
} from '@frontrangesystems/business-os-extraction-engine';

const vision = createAnthropicVisionClient({ apiKey: process.env.ANTHROPIC_API_KEY! });

const result = await parseDocument({
  pdfPath: '/tmp/plans.pdf',
  tmpDir: '/tmp/work',
  vision,
  model: 'claude-opus-4-8',
  pricing: OPUS_4_8_PRICING,
  taxonomy: CONSTRUCTION_BID_TAXONOMY, // or a per-company taxonomy
  logger,
});

// result.items       -> deduped pay-items { description, itemCode, unit, quantity, sourcePage }
// result.pages        -> per-page { pageType, text, source, items }
// result.pageTexts    -> Map<pageNo, string> for search/preview
// result.costUsd, result.inputTokens, result.outputTokens
```

## Per-company customization

Prompts are **not** hardcoded to one jurisdiction. Pass an `ExtractionTaxonomy`
(domain description, allowed page types, item-field guidance, whether to capture
quantity). This is the seam that lets Company A (curb-and-gutter LF + concrete
CY) and Company B (asphalt tonnage) share one engine with different behavior —
same code, different config. The consuming module surfaces these as settings.

## Provider abstraction

The engine depends only on the minimal `VisionLlmClient` interface. The default
implementation wraps Anthropic (`createAnthropicVisionClient`) and handles retry
+ oversize-image detection; tests inject a fake. A vision *connector capability*
could back this later without changing the engine.

## What stays out

- **Persistence / storage** — the consuming module owns tables + object storage.
- **Ref / match-rule linking** — that is bid-indexer's operator-training feature,
  not generic extraction. The engine returns items + page text; the module links.
