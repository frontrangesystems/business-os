-- @business-os/module-document-parser / 0001_init
--
-- The Document Parser pilot product. A slim, standalone module on top of the
-- shared extraction engine: upload a PDF, extract a structured takeoff
-- (pay-items with quantity), search page text, export CSV. NO bid-workflow
-- (no projects, match rules, doc ordering, bid matching) — that stays in C&M's
-- bid-indexer.

-- 1) Documents --------------------------------------------------------------
CREATE TABLE document_parser_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_filename text NOT NULL,
  storage_key       text NOT NULL,
  status            text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'parsing', 'parsed', 'failed')),
  page_count        integer,
  content_hash      text,
  title             text,
  suggested_title   text,
  jurisdiction      text,
  cost_usd          numeric,
  uploaded_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  parsed_at         timestamptz,
  error             text
);

CREATE INDEX document_parser_documents_uploaded_at_idx
  ON document_parser_documents (uploaded_at DESC);

-- 2) Extracted takeoff items ------------------------------------------------
-- quantity is stored twice: quantity_extracted (what the model read, immutable)
-- + quantity (the effective value the operator can override).
CREATE TABLE document_parser_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id        uuid NOT NULL
    REFERENCES document_parser_documents(id) ON DELETE CASCADE,
  description        text NOT NULL,
  item_code          text,
  unit               text,
  quantity_extracted numeric,
  quantity           numeric,
  quantity_overridden boolean NOT NULL DEFAULT false,
  page_no            integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_parser_items_document_id_idx
  ON document_parser_items (document_id);

-- 3) Per-page text + full-text index ----------------------------------------
-- `to_tsvector('english', content)` is IMMUTABLE, so the tsvector is a STORED
-- generated column (english config: stemming + stop-words), GIN-indexed. No
-- trigger to maintain — "sod" finds "sodding" for free.
CREATE TABLE document_parser_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL
    REFERENCES document_parser_documents(id) ON DELETE CASCADE,
  page_no     integer NOT NULL,
  content     text NOT NULL DEFAULT '',
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (document_id, page_no)
);

CREATE INDEX document_parser_pages_tsv_idx ON document_parser_pages USING gin (tsv);
CREATE INDEX document_parser_pages_document_id_idx ON document_parser_pages (document_id);
