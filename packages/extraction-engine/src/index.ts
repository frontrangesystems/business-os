/**
 * @frontrangesystems/business-os-extraction-engine
 *
 * Reusable PDF → takeoff/pay-item extraction engine. Renders pages, OCRs
 * image-only sheets with a vision LLM, extracts structured pay-items (with
 * quantity), and reports cost. A pure library: no DB, no object storage, no
 * framework/module/agent coupling.
 *
 * The consuming module owns persistence, upload/storage, and any ref/match-rule
 * linking. The engine owns the expensive, reusable brain.
 */

export type {
  Logger,
  PayItem,
  ExtractedItem,
  LlmUsage,
  PageSource,
  ParsedPage,
  ParseResult,
  DocumentShape,
  ShapeSignal,
} from './types.js';

export type { DetectShapeInput } from './shape.js';
export { detectDocumentShape } from './shape.js';

export type {
  ScopeCitation,
  ScopeStatus,
  ScopeFinding,
  ScopeResult,
  ExtractScopeInput,
} from './scope.js';
export { extractScope, canonicalizeItem } from './scope.js';

export type { Pricing, EngineTuning } from './config.js';
export { OPUS_4_8_PRICING } from './config.js';

export type { ExtractionTaxonomy } from './taxonomy.js';
export { CONSTRUCTION_BID_TAXONOMY } from './taxonomy.js';

export type {
  VisionLlmClient,
  LlmImage,
  LlmImageMediaType,
  LlmCompletion,
  LlmCompletionRequest,
  AnthropicVisionClientOptions,
} from './vision-client.js';
export { OversizeImageError, createAnthropicVisionClient } from './vision-client.js';

export type { ParseDocumentInput, DocumentMeta } from './parse.js';
export { parseDocument, extractMeta } from './parse.js';

export type { PageDims } from './pdf.js';
export { pageCountOf, pageDimsOf } from './pdf.js';
