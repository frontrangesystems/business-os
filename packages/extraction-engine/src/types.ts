/**
 * Public data types for the extraction engine.
 *
 * The engine is a pure library: no DB, no object storage, no framework
 * coupling. It takes a PDF on disk + a vision-LLM client and returns structured
 * pages + pay-items + cost. These types are the contract a consuming module
 * (Document Parser, C&M bid-indexer) builds its own persistence around.
 */

/** Minimal structured logger (matches the pino `info(obj, msg)` shape). */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** A single pay-item / bid-summary row as extracted from one page. */
export interface PayItem {
  /** Plain-English item description, verbatim as written. */
  description: string;
  /** Item/pay code (e.g. "601-01") if shown, else null. */
  itemCode: string | null;
  /** Unit of measure (e.g. SQYD, LNFT, EACH) if shown, else null. */
  unit: string | null;
  /**
   * Numeric quantity if shown, else null. Captured because a takeoff product
   * needs quantity — the consuming module stores the extracted value immutably
   * and lets the operator override it.
   */
  quantity: number | null;
}

/** A deduped pay-item across the whole document. */
export interface ExtractedItem extends PayItem {
  /** 1-based page the item was first collected from. */
  sourcePage: number;
}

/** Token usage for one LLM call. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/** How a page's text + items were obtained. */
export type PageSource = 'text' | 'vision';

/** Per-page extraction result. */
export interface ParsedPage {
  /** 1-based page number. */
  page: number;
  /** Model-assigned page type (from the taxonomy's set), or null. */
  pageType: string | null;
  /** Best searchable text for the page (text layer or OCR transcription). */
  text: string;
  /** How this page was processed. */
  source: PageSource;
  /** Pay-items found on this page (pre-dedup). */
  items: PayItem[];
}

/** The full result of parsing one document. */
export interface ParseResult {
  /** Pay-items deduped across all pages by (normalized description + code). */
  items: ExtractedItem[];
  /** Per-page results (text + page-local items). */
  pages: ParsedPage[];
  /** Best searchable text keyed by 1-based page number. */
  pageTexts: Map<number, string>;
  /** Page(s) that look like the bid summary / schedule of items. */
  summaryPages: number[];
  /** Total pages in the PDF. */
  pageCount: number;
  /** How many pages were processed via vision OCR. */
  visionPages: number;
  /** How many pages were processed via their text layer. */
  textPages: number;
  /** Estimated cost in USD from token usage × pricing. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}
