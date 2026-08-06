import { pgTable, text, integer, numeric, boolean, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';
import type { ScopeCitation } from '@frontrangesystems/business-os-extraction-engine';

/**
 * Document Parser — module-owned schema. Deliberately NO bid-workflow tables
 * (no projects, match rules, doc ordering, bid matching). Just: uploaded
 * documents, their extracted takeoff items, and per-page text for search.
 */

/**
 * One row per uploaded PDF. Bytes live in object storage at `storageKey`; this
 * table holds metadata + lifecycle. Parsing flips status
 * 'uploaded' -> 'parsing' -> 'parsed'/'failed'.
 */
export const documentParserDocuments = pgTable('document_parser_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalFilename: text('original_filename').notNull(),
  /** Object-storage key, e.g. `documents/<id>/original.pdf`. */
  storageKey: text('storage_key').notNull(),
  status: text('status').notNull().default('uploaded'),
  pageCount: integer('page_count'),
  /** sha256 of the uploaded bytes — detects exact re-uploads. */
  contentHash: text('content_hash'),
  /** Operator-set human title; primary label when present. */
  title: text('title'),
  /** Auto-extracted title from the cover sheet during parsing (a prefill). */
  suggestedTitle: text('suggested_title'),
  jurisdiction: text('jurisdiction'),
  /**
   * Which shape the extractor resolved to: 'schedule' (Mode A — pay-item rows)
   * or 'narrative' (Mode B — scope read from specs/drawings). Null until parsed.
   */
  shape: text('shape'),
  /** Estimated extraction cost in USD (tokens × pricing). */
  costUsd: numeric('cost_usd'),
  uploadedBy: uuid('uploaded_by'),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  parsedAt: timestamp('parsed_at', { withTimezone: true }),
  error: text('error'),
});

/**
 * Extracted takeoff items — one row per deduped pay-item found in a document.
 *
 * Quantity is stored in TWO columns so the operator can override without losing
 * what the model read:
 *   - `quantityExtracted` — what the extraction engine read (immutable).
 *   - `quantity`          — the effective value; defaults to extracted, edited
 *                           inline by the operator.
 */
export const documentParserItems = pgTable('document_parser_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull(),
  description: text('description').notNull(),
  itemCode: text('item_code'),
  unit: text('unit'),
  /** What the model read (immutable provenance). */
  quantityExtracted: numeric('quantity_extracted'),
  /** Effective quantity — operator-editable; defaults to the extracted value. */
  quantity: numeric('quantity'),
  /** Whether the operator has overridden the extracted quantity. */
  quantityOverridden: boolean('quantity_overridden').notNull().default(false),
  pageNo: integer('page_no'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per page per document — the searchable text layer. `content` is the
 * verbatim page text. The DB carries a generated `tsvector` (Postgres `english`
 * config) with a GIN index for full-text search; the tsvector is never read
 * through Drizzle (search runs as raw SQL), so it is intentionally not mapped.
 */
export const documentParserPages = pgTable('document_parser_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull(),
  pageNo: integer('page_no').notNull(),
  content: text('content').notNull().default(''),
});

/**
 * Mode B scope findings — one row per trade-scope checklist item the engine
 * found evidence for in a narrative document. `citations` holds the verbatim
 * supporting snippets ({page, snippet}). Only populated for narrative-shape
 * documents; Mode A schedule docs use `documentParserItems` instead.
 */
export const documentParserScopeFindings = pgTable('document_parser_scope_findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull(),
  /** Canonical checklist item (verbatim from the configured scope checklist). */
  item: text('item').notNull(),
  /** 'present' = clear evidence; 'uncertain' = the text hints but is ambiguous. */
  status: text('status').notNull().default('present'),
  /** Verbatim supporting snippets, capped by the engine. */
  citations: jsonb('citations').$type<ScopeCitation[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
