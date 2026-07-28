import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/postgres-js';

import { documentParserPages } from './schema.js';

/**
 * Mirror a document's verbatim per-page text into `document_parser_pages` so it
 * is tsvector-indexed for full-text search. Called by the parse worker once
 * extraction finishes — this module has no pre-existing documents to backfill,
 * so (unlike bid-indexer) there is no lazy Tigris backfill path.
 */

type Db = ReturnType<typeof drizzle>;

/** One multi-row INSERT per batch keeps statements small. */
const INSERT_BATCH = 200;

/**
 * Replace every page row for a document with the given page text. Idempotent:
 * deletes the document's existing rows first, then inserts the supplied pages
 * (page numbers >= 1). The generated tsvector maintains itself. Transactional
 * so a search never sees a half-written set.
 */
export async function replacePages(
  db: Db,
  documentId: string,
  pageTexts: Map<number, string>,
): Promise<number> {
  const rows = [...pageTexts.entries()]
    .filter(([page]) => Number.isInteger(page) && page >= 1)
    .map(([page, content]) => ({ documentId, pageNo: page, content: content ?? '' }));

  await db.transaction(async (tx) => {
    await tx.delete(documentParserPages).where(eq(documentParserPages.documentId, documentId));
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const batch = rows.slice(i, i + INSERT_BATCH);
      if (batch.length > 0) await tx.insert(documentParserPages).values(batch);
    }
  });

  return rows.length;
}
