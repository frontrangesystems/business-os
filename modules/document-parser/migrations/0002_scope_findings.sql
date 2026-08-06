-- @business-os/module-document-parser / 0002_scope_findings
--
-- Mode B (narrative documents). A building/commercial set has no pay-item
-- schedule — scope is read from the specs + drawings against a fixed trade
-- scope checklist (see the shared engine's `extractScope`). This adds:
--   * documents.shape — which mode the parse resolved to ('schedule'|'narrative')
--   * a scope-findings table — one row per checklist item found, with verbatim
--     citations. The Mode A items table is untouched.

-- Record which shape the extractor resolved to (null = pre-0002 / not yet parsed).
ALTER TABLE document_parser_documents
  ADD COLUMN shape text
    CHECK (shape IN ('schedule', 'narrative'));

-- Scope findings — Mode B output. One row per checklist item with evidence.
-- `citations` is a JSON array of {page, snippet} (verbatim support, capped in
-- the engine). status: 'present' (clear evidence) | 'uncertain' (ambiguous).
CREATE TABLE document_parser_scope_findings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL
    REFERENCES document_parser_documents(id) ON DELETE CASCADE,
  item        text NOT NULL,
  status      text NOT NULL DEFAULT 'present'
    CHECK (status IN ('present', 'uncertain')),
  citations   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_parser_scope_findings_document_id_idx
  ON document_parser_scope_findings (document_id);
