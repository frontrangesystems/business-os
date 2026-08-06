import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';
import {
  documentParserDocuments,
  documentParserItems,
  documentParserScopeFindings,
} from '../src/server/schema.js';
import { replacePages } from '../src/server/pages.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const suite = reachable ? describe : describe.skip;
if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(`[document-parser] skipping integration tests — ${TEST_DATABASE_URL} unreachable`);
}

suite('document-parser schema (real Postgres)', () => {
  let db: Awaited<ReturnType<typeof freshDb>>['db'];
  let sqlClient: Awaited<ReturnType<typeof freshDb>>['sql'];

  beforeAll(async () => {
    const h = await freshDb();
    db = h.db;
    sqlClient = h.sql;
  });

  afterAll(async () => {
    await sqlClient?.end({ timeout: 1 }).catch(() => {});
  });

  async function newDocument(filename = 'plans.pdf'): Promise<string> {
    const [doc] = await db
      .insert(documentParserDocuments)
      .values({ originalFilename: filename, storageKey: `documents/x/${filename}`, status: 'parsed' })
      .returning();
    return doc!.id;
  }

  it('applies the migration and stores an extracted item with two quantity columns', async () => {
    const docId = await newDocument();
    await db.insert(documentParserItems).values({
      documentId: docId,
      description: 'Slab Sodding (St. Augustine)',
      itemCode: '714-01',
      unit: 'SQYD',
      quantityExtracted: '500',
      quantity: '500',
    });
    const [item] = await db
      .select()
      .from(documentParserItems)
      .where(eq(documentParserItems.documentId, docId));
    expect(item?.quantityExtracted).toBe('500');
    expect(item?.quantity).toBe('500');
    expect(item?.quantityOverridden).toBe(false);
  });

  it('override changes the effective quantity but preserves the extracted value', async () => {
    const docId = await newDocument('override.pdf');
    const [item] = await db
      .insert(documentParserItems)
      .values({
        documentId: docId,
        description: 'Curb and Gutter',
        quantityExtracted: '1200',
        quantity: '1200',
      })
      .returning();

    // Operator overrides 1200 -> 1250.
    await db
      .update(documentParserItems)
      .set({ quantity: '1250', quantityOverridden: true })
      .where(eq(documentParserItems.id, item!.id));

    const [after] = await db
      .select()
      .from(documentParserItems)
      .where(eq(documentParserItems.id, item!.id));
    expect(after?.quantity).toBe('1250');
    expect(after?.quantityExtracted).toBe('1200'); // provenance intact
    expect(after?.quantityOverridden).toBe(true);
  });

  it('full-text search finds a page by stemmed term (sod -> sodding)', async () => {
    const docId = await newDocument('search.pdf');
    await replacePages(
      db,
      docId,
      new Map([
        [1, 'SCHEDULE OF ITEMS'],
        [2, 'Slab Sodding along the shoulder, St. Augustine variety'],
      ]),
    );

    const tsq = sql`websearch_to_tsquery('english', ${'sod'})`;
    const rows = (await db.execute(sql`
      SELECT p.page_no AS page_no,
             ts_headline('english', p.content, ${tsq}, 'StartSel=«,StopSel=»') AS snippet
      FROM document_parser_pages p
      WHERE p.document_id = ${docId} AND p.tsv @@ ${tsq}
      ORDER BY p.page_no
    `)) as unknown as Array<{ page_no: number; snippet: string }>;

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.page_no)).toBe(2);
    expect(rows[0]!.snippet).toContain('«'); // matched term highlighted
  });

  it('stores a Mode B scope finding with JSON citations and a shape', async () => {
    const [doc] = await db
      .insert(documentParserDocuments)
      .values({
        originalFilename: 'building.pdf',
        storageKey: 'documents/x/building.pdf',
        status: 'parsed',
        shape: 'narrative',
      })
      .returning();
    const docId = doc!.id;

    await db.insert(documentParserScopeFindings).values({
      documentId: docId,
      item: 'slab on grade',
      status: 'present',
      citations: [
        { page: 3, snippet: '5" SLAB ON GRADE, 4000 PSI' },
        { page: 5, snippet: 'SOG reinforced with #4 @ 18" o.c.' },
      ],
    });

    const [row] = await db
      .select()
      .from(documentParserScopeFindings)
      .where(eq(documentParserScopeFindings.documentId, docId));
    expect(row?.item).toBe('slab on grade');
    expect(row?.status).toBe('present');
    expect(row?.citations).toHaveLength(2);
    expect(row?.citations[0]).toEqual({ page: 3, snippet: '5" SLAB ON GRADE, 4000 PSI' });

    const [after] = await db
      .select()
      .from(documentParserDocuments)
      .where(eq(documentParserDocuments.id, docId));
    expect(after?.shape).toBe('narrative');
  });

  it('deleting a document cascades to its items, pages, and scope findings', async () => {
    const docId = await newDocument('cascade.pdf');
    await db.insert(documentParserItems).values({ documentId: docId, description: 'X' });
    await replacePages(db, docId, new Map([[1, 'some page text']]));
    await db.insert(documentParserScopeFindings).values({
      documentId: docId,
      item: 'footings',
      status: 'uncertain',
      citations: [{ page: 1, snippet: 'see structural' }],
    });

    await db.delete(documentParserDocuments).where(eq(documentParserDocuments.id, docId));

    const items = await db
      .select()
      .from(documentParserItems)
      .where(eq(documentParserItems.documentId, docId));
    const findings = await db
      .select()
      .from(documentParserScopeFindings)
      .where(eq(documentParserScopeFindings.documentId, docId));
    const pageCount = (await db.execute(
      sql`SELECT count(*)::int AS n FROM document_parser_pages WHERE document_id = ${docId}`,
    )) as unknown as Array<{ n: number }>;
    expect(items).toHaveLength(0);
    expect(findings).toHaveLength(0);
    expect(Number(pageCount[0]!.n)).toBe(0);
  });
});
