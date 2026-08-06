import { randomUUID, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, type Readable } from 'node:stream';
import { z } from 'zod';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  defineModule,
  type ModuleServerContext,
  type ModuleUiPage,
} from '@frontrangesystems/business-os-module-sdk';
import { requireUser } from '@frontrangesystems/business-os-core';

import {
  documentParserDocuments,
  documentParserItems,
  documentParserScopeFindings,
} from './schema.js';
import { SettingsSchema, type Settings } from './settings.js';
import { putStream, getObject, deleteObject } from './storage.js';
import { parseDocumentHandler } from './parse-worker.js';

/**
 * @frontrangesystems/business-os-module-document-parser
 *
 * The Document Parser pilot product. Upload a plan set / spec PDF → stored in
 * object storage → row persisted (status 'uploaded') → the upload route enqueues
 * the module's own `parse` worker, which runs the shared extraction engine and
 * writes the takeoff (pay-items with quantity) + per-page search text. Slim UI:
 * upload, document list with status, per-document takeoff with editable
 * quantity, full-text search, CSV export. No bid-workflow.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** 100 MB cap on upload size. */
const MAX_PDF_BYTES = 100 * 1024 * 1024;
/** PDF magic number "%PDF-". */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

/** A single multipart file part (structural slice of @fastify/multipart). */
interface MultipartFile {
  file: Readable & { truncated?: boolean };
  filename: string;
  mimetype: string;
  truncated?: boolean;
}
type UploadRequest = FastifyRequest & { file(): Promise<MultipartFile | undefined> };

const UpdateDocumentBody = z.object({
  title: z.string().max(200).nullable().optional(),
});

const UpdateItemBody = z.object({
  /** New effective quantity. null clears it; a number overrides the extracted value. */
  quantity: z.number().nullable(),
});

function buildDb(): ReturnType<typeof drizzle> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('document-parser: DATABASE_URL not set');
  const client = postgres(url, { max: 4 });
  return drizzle(client);
}

function normText(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** numeric columns arrive as strings; present them to the UI as numbers. */
function toNum(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function serializeDocument(row: typeof documentParserDocuments.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    originalFilename: row.originalFilename,
    status: row.status,
    shape: row.shape,
    pageCount: row.pageCount,
    title: row.title,
    suggestedTitle: row.suggestedTitle,
    jurisdiction: row.jurisdiction,
    costUsd: toNum(row.costUsd),
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt instanceof Date ? row.uploadedAt.toISOString() : row.uploadedAt,
    parsedAt: row.parsedAt instanceof Date ? row.parsedAt.toISOString() : row.parsedAt,
    error: row.error,
  };
}

function serializeScopeFinding(
  row: typeof documentParserScopeFindings.$inferSelect,
): Record<string, unknown> {
  return {
    id: row.id,
    item: row.item,
    status: row.status,
    citations: row.citations,
  };
}

function serializeItem(row: typeof documentParserItems.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    description: row.description,
    itemCode: row.itemCode,
    unit: row.unit,
    quantity: toNum(row.quantity),
    quantityExtracted: toNum(row.quantityExtracted),
    quantityOverridden: row.quantityOverridden,
    pageNo: row.pageNo,
  };
}

/** Server-side nav metadata for the operator sidebar (real components are wired
 * client-side in main.tsx). Keep in sync with the UI's exported uiPages. */
const navPlaceholder: ModuleUiPage['Component'] = () => null;
const navPages: ModuleUiPage[] = [
  { path: '', navLabel: 'Document Parser', Component: navPlaceholder },
  { path: 'search', navLabel: 'Search', Component: navPlaceholder },
];

/** One CSV field, quoted + escaped per RFC 4180. */
function csvField(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default defineModule({
  uiPages: navPages,
  manifest: {
    slug: 'document-parser',
    version: '0.0.2',
    displayName: 'Document Parser',
    description: 'Upload plan sets/specs; extract a structured takeoff (pay-items with quantity), search page text, and export CSV.',
    settingsSchema: SettingsSchema,
    // The engine does Claude vision, which the text-only `llm` capability can't
    // express — the parse worker resolves the raw key via connectorCredentials.
    requiredConnectors: ['llm'],
    migrationsDir: resolve(here, '..', '..', 'migrations'),
  },
  registerRoutes: (rawApp, ctx: ModuleServerContext<Settings>) => {
    const app = rawApp as FastifyInstance;
    const db = buildDb();

    /**
     * POST /api/modules/document-parser/upload
     * multipart/form-data with a single `file` part (a PDF). Enforces the
     * document cap, streams to storage, dedups exact re-uploads, inserts a row
     * (status 'uploaded'), enqueues the `parse` worker.
     */
    app.post('/upload', { preHandler: requireUser }, async (rawReq: FastifyRequest, reply: FastifyReply) => {
      const req = rawReq as UploadRequest;

      // Enforce the document cap up front (0 = unlimited).
      const limit = ctx.settings.documentLimit;
      if (limit > 0) {
        const [{ count } = { count: 0 }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(documentParserDocuments);
        if (count >= limit) {
          return reply
            .code(403)
            .send({ error: 'document_limit_reached', limit, message: `Pilot limit reached (${count}/${limit}). Upgrade to add more documents.` });
        }
      }

      const part = await req.file();
      if (!part) return reply.code(400).send({ error: 'no file uploaded' });

      const filename = part.filename;
      if (!filename || !/\.pdf$/i.test(filename)) {
        part.file.resume();
        return reply.code(400).send({ error: 'filename must end in .pdf' });
      }

      const id = randomUUID();
      const storageKey = `documents/${id}/original.pdf`;

      // Sniff the PDF magic bytes + enforce the size cap as bytes stream, and
      // hash for de-dup — all without buffering the whole file.
      const pass = new PassThrough();
      const hash = createHash('sha256');
      let sniffed = false;
      let sniffedIsPdf = false;
      let bytesSeen = 0;
      let capExceeded = false;

      part.file.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        if (!sniffed && chunk.length > 0) {
          sniffed = true;
          const head = chunk.subarray(0, PDF_MAGIC.length);
          sniffedIsPdf = head.length >= PDF_MAGIC.length && head.equals(PDF_MAGIC);
          if (!sniffedIsPdf) {
            part.file.destroy(new Error('not_a_pdf'));
            pass.destroy(new Error('not_a_pdf'));
            return;
          }
        }
        bytesSeen += chunk.length;
        if (bytesSeen > MAX_PDF_BYTES) {
          capExceeded = true;
          part.file.destroy(new Error('file_too_large'));
          pass.destroy(new Error('file_too_large'));
        }
      });
      part.file.pipe(pass);

      try {
        await putStream(storageKey, pass, 'application/pdf');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'upload_failed';
        if (message === 'not_a_pdf') return reply.code(400).send({ error: 'file is not a PDF' });
        if (message === 'file_too_large' || capExceeded) {
          return reply.code(400).send({ error: `file exceeds ${MAX_PDF_BYTES} byte limit` });
        }
        if (part.file.truncated || part.truncated) {
          return reply.code(400).send({ error: `file exceeds ${MAX_PDF_BYTES} byte limit` });
        }
        await req.audit('document-parser.upload.failed', { storageKey, message });
        req.log.error({ storageKey, err: message }, 'document.upload_failed');
        return reply.code(500).send({ error: 'upload_failed' });
      }

      if (part.file.truncated || part.truncated) {
        return reply.code(400).send({ error: `file exceeds ${MAX_PDF_BYTES} byte limit` });
      }
      if (bytesSeen === 0) return reply.code(400).send({ error: 'empty file' });
      if (!sniffedIsPdf) return reply.code(400).send({ error: 'file is not a PDF' });

      const contentHash = hash.digest('hex');

      // De-dupe: an exact re-upload (same bytes) returns the existing document
      // instead of re-parsing (parsing costs API $). A prior 'failed' doesn't
      // count — let a failed doc be retried by re-uploading. ?force=1 overrides.
      const force = (req.query as { force?: string }).force === '1';
      if (!force) {
        const [existing] = await db
          .select()
          .from(documentParserDocuments)
          .where(and(eq(documentParserDocuments.contentHash, contentHash), ne(documentParserDocuments.status, 'failed')))
          .orderBy(desc(documentParserDocuments.uploadedAt))
          .limit(1);
        if (existing) {
          await deleteObject(storageKey).catch(() => undefined);
          req.log.info({ duplicateOf: existing.id, filename }, 'document.upload_duplicate');
          return reply.code(200).send({ duplicate: true, existing: serializeDocument(existing) });
        }
      }

      const [row] = await db
        .insert(documentParserDocuments)
        .values({
          id,
          originalFilename: filename,
          storageKey,
          status: 'uploaded',
          contentHash,
          uploadedBy: req.user?.id ?? null,
        })
        .returning();
      if (!row) return reply.code(500).send({ error: 'insert_failed' });

      await req.audit('document-parser.upload', { documentId: id, filename, bytes: bytesSeen });
      await ctx.enqueue('parse', { documentId: id });
      req.log.info({ documentId: id, filename, bytes: bytesSeen }, 'document.uploaded');

      return serializeDocument(row);
    });

    /** GET /documents — list, newest first. */
    app.get('/documents', { preHandler: requireUser }, async () => {
      const rows = await db
        .select()
        .from(documentParserDocuments)
        .orderBy(desc(documentParserDocuments.uploadedAt));
      return { documents: rows.map(serializeDocument), documentLimit: ctx.settings.documentLimit };
    });

    /** GET /documents/:id — one document + its extracted items. */
    app.get('/documents/:id', { preHandler: requireUser }, async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const [row] = await db
        .select()
        .from(documentParserDocuments)
        .where(eq(documentParserDocuments.id, id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const items = await db
        .select()
        .from(documentParserItems)
        .where(eq(documentParserItems.documentId, id))
        .orderBy(documentParserItems.pageNo, documentParserItems.createdAt);
      const scopeFindings = await db
        .select()
        .from(documentParserScopeFindings)
        .where(eq(documentParserScopeFindings.documentId, id))
        .orderBy(documentParserScopeFindings.createdAt);
      return {
        ...serializeDocument(row),
        items: items.map(serializeItem),
        scopeFindings: scopeFindings.map(serializeScopeFinding),
      };
    });

    /** PATCH /documents/:id — set the operator title. */
    app.patch('/documents/:id', { preHandler: requireUser }, async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdateDocumentBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      if (parsed.data.title === undefined) return reply.code(400).send({ error: 'no_fields' });
      const [row] = await db
        .update(documentParserDocuments)
        .set({ title: normText(parsed.data.title) })
        .where(eq(documentParserDocuments.id, id))
        .returning();
      if (!row) return reply.code(404).send({ error: 'not_found' });
      await req.audit('document-parser.document.update', { documentId: id, fields: ['title'] });
      return serializeDocument(row);
    });

    /**
     * PATCH /documents/:id/items/:itemId — override an item's quantity. The
     * extracted value (`quantityExtracted`) is never touched; `quantity` becomes
     * the effective value and the row is flagged overridden.
     */
    app.patch('/documents/:id/items/:itemId', { preHandler: requireUser }, async (req: FastifyRequest, reply: FastifyReply) => {
      const { id, itemId } = req.params as { id: string; itemId: string };
      const parsed = UpdateItemBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const q = parsed.data.quantity;
      const [row] = await db
        .update(documentParserItems)
        .set({ quantity: q === null ? null : String(q), quantityOverridden: true })
        .where(and(eq(documentParserItems.id, itemId), eq(documentParserItems.documentId, id)))
        .returning();
      if (!row) return reply.code(404).send({ error: 'not_found' });
      await req.audit('document-parser.item.quantity.override', { documentId: id, itemId, quantity: q });
      return serializeItem(row);
    });

    /** DELETE /documents/:id — remove the document (items + pages cascade) and
     * its stored PDF. */
    app.delete('/documents/:id', { preHandler: requireUser }, async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const [row] = await db
        .delete(documentParserDocuments)
        .where(eq(documentParserDocuments.id, id))
        .returning();
      if (!row) return reply.code(404).send({ error: 'not_found' });
      await deleteObject(row.storageKey).catch(() => undefined);
      await req.audit('document-parser.document.delete', { documentId: id });
      return { ok: true };
    });

    /**
     * GET /documents/:id/export.csv — download the extracted takeoff as CSV.
     * Columns: Description, Item Code, Unit, Quantity, Page. Uses the effective
     * (possibly overridden) quantity.
     */
    app.get('/documents/:id/export.csv', { preHandler: requireUser }, async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const [doc] = await db
        .select()
        .from(documentParserDocuments)
        .where(eq(documentParserDocuments.id, id))
        .limit(1);
      if (!doc) return reply.code(404).send({ error: 'not_found' });
      const items = await db
        .select()
        .from(documentParserItems)
        .where(eq(documentParserItems.documentId, id))
        .orderBy(documentParserItems.pageNo, documentParserItems.createdAt);

      const header = ['Description', 'Item Code', 'Unit', 'Quantity', 'Page'];
      const lines = [header.map(csvField).join(',')];
      for (const it of items) {
        lines.push(
          [csvField(it.description), csvField(it.itemCode), csvField(it.unit), csvField(toNum(it.quantity)), csvField(it.pageNo)].join(','),
        );
      }
      const csv = lines.join('\r\n');
      const base = (doc.title ?? doc.suggestedTitle ?? doc.originalFilename.replace(/\.pdf$/i, '') ?? 'takeoff')
        .replace(/[^a-z0-9-_]+/gi, '_')
        .slice(0, 60);
      await req.audit('document-parser.export', { documentId: id, items: items.length });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${base || 'takeoff'}.csv"`)
        .send(csv);
    });

    /**
     * GET /search?q=<terms> — full-text search across every page of every
     * document (english FTS: stemming + ranking). Returns the pages where terms
     * occur with a highlighted snippet (matched terms wrapped in «...»).
     */
    app.get('/search', { preHandler: requireUser }, async (req: FastifyRequest) => {
      const q = ((req.query as { q?: string }).q ?? '').trim().slice(0, 200);
      if (q.length === 0) return { query: q, results: [] };
      const tsq = sql`websearch_to_tsquery('english', ${q})`;
      const rows = (await db.execute(sql`
        SELECT p.document_id                       AS document_id,
               d.original_filename                 AS original_filename,
               d.title                             AS title,
               d.suggested_title                   AS suggested_title,
               p.page_no                           AS page_no,
               ts_headline('english', p.content, ${tsq},
                 'StartSel=«,StopSel=»,MaxFragments=2,MinWords=4,MaxWords=18,FragmentDelimiter= … ')
                                                   AS snippet,
               ts_rank(p.tsv, ${tsq})              AS rank
        FROM document_parser_pages p
        JOIN document_parser_documents d ON d.id = p.document_id
        WHERE p.tsv @@ ${tsq}
        ORDER BY rank DESC, p.page_no ASC
        LIMIT 100
      `)) as unknown as Array<{
        document_id: string;
        original_filename: string;
        title: string | null;
        suggested_title: string | null;
        page_no: number;
        snippet: string;
        rank: number;
      }>;
      return {
        query: q,
        results: rows.map((r) => ({
          documentId: r.document_id,
          originalFilename: r.original_filename,
          title: r.title,
          suggestedTitle: r.suggested_title,
          page: Number(r.page_no),
          snippet: r.snippet,
          rank: Number(r.rank),
        })),
      };
    });

    ctx.logger.info('document-parser routes ready');
  },
  backgroundWorkers: {
    parse: parseDocumentHandler,
  },
});

export { documentParserDocuments, documentParserItems, documentParserScopeFindings } from './schema.js';
