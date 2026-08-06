import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type {
  ModuleBackgroundWorkerHandler,
  ModuleWorkerContext,
} from '@frontrangesystems/business-os-module-sdk';
import {
  parseDocument,
  extractMeta,
  extractScope,
  createAnthropicVisionClient,
} from '@frontrangesystems/business-os-extraction-engine';

import {
  documentParserDocuments,
  documentParserItems,
  documentParserScopeFindings,
} from './schema.js';
import { getObject } from './storage.js';
import { replacePages } from './pages.js';
import { buildTaxonomy, pricingFor, type Settings } from './settings.js';

/**
 * `parse` background worker. Triggered by the upload route's
 * `ctx.enqueue('parse', { documentId })` — NOT an agent (no Agents-list entry,
 * no enable bit, no schedule). Runs the shared extraction engine over the
 * uploaded PDF and persists the takeoff + page text.
 *
 * The Anthropic key comes from the operator-bound `llm` connector instance
 * (declared in the manifest's requiredConnectors), resolved via
 * `ctx.connectorCredentials('llm')` — the escape hatch for raw-credential needs,
 * since the engine does Claude vision the text-only `llm` capability can't
 * express. No `process.env.ANTHROPIC_API_KEY`.
 */

const MAX_ERROR_LEN = 1000;

const ParsePayload = z.object({ documentId: z.string().uuid() });

type Db = ReturnType<typeof drizzle>;

function buildDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('document-parser worker: DATABASE_URL not set');
  const client = postgres(url, { max: 4 });
  return drizzle(client);
}

/** numeric columns round-trip as strings in Drizzle; null stays null. */
function num(v: number | null): string | null {
  return v === null ? null : String(v);
}

/** Resolve the operator-bound Anthropic API key from the llm connector. */
async function resolveApiKey(ctx: ModuleWorkerContext<Settings>): Promise<string> {
  const binding = await ctx.connectorCredentials('llm');
  const creds = binding.credentials;
  if (creds.kind === 'api-key') return creds.key;
  throw new Error(
    `document-parser: llm connector '${binding.providerSlug}' has no api-key credential (kind=${creds.kind})`,
  );
}

export const parseDocumentHandler: ModuleBackgroundWorkerHandler<Settings> = async (
  ctx: ModuleWorkerContext<Settings>,
  payload: unknown,
): Promise<void> => {
  const parsed = ParsePayload.safeParse(payload);
  if (!parsed.success) {
    ctx.logger.error({ payload }, 'document-parser.parse.bad_payload');
    return;
  }
  const { documentId } = parsed.data;
  const db = buildDb();

  const [doc] = await db
    .select()
    .from(documentParserDocuments)
    .where(eq(documentParserDocuments.id, documentId))
    .limit(1);
  if (!doc) {
    ctx.logger.warn({ documentId }, 'document-parser.parse.not_found');
    return;
  }

  // Claim it so a re-enqueue doesn't reprocess one already in flight.
  await db
    .update(documentParserDocuments)
    .set({ status: 'parsing', error: null })
    .where(eq(documentParserDocuments.id, doc.id));

  ctx.logger.info({ documentId: doc.id, filename: doc.originalFilename }, 'document-parser.parse.start');

  let tmp: string | null = null;
  try {
    const apiKey = await resolveApiKey(ctx);
    const vision = createAnthropicVisionClient({ apiKey });
    const model = ctx.settings.model;
    const taxonomy = buildTaxonomy(ctx.settings);

    tmp = await mkdtemp(join(tmpdir(), 'doc-parse-'));
    const pdfPath = join(tmp, 'original.pdf');
    const pdfBytes = await getObject(doc.storageKey);
    await writeFile(pdfPath, Buffer.from(pdfBytes));

    const result = await parseDocument({
      pdfPath,
      tmpDir: tmp,
      vision,
      model,
      pricing: pricingFor(model),
      taxonomy,
      logger: ctx.logger,
      logId: doc.id,
    });

    const meta = await extractMeta({
      vision,
      model,
      taxonomy,
      pageTexts: result.pageTexts,
      summaryPages: result.summaryPages,
      logger: ctx.logger,
    });

    // Persist items: replace any prior extraction for this document.
    await db.transaction(async (tx) => {
      await tx.delete(documentParserItems).where(eq(documentParserItems.documentId, doc.id));
      const rows = result.items.map((it) => ({
        documentId: doc.id,
        description: it.description,
        itemCode: it.itemCode,
        unit: it.unit,
        quantityExtracted: num(it.quantity),
        quantity: num(it.quantity),
        quantityOverridden: false,
        pageNo: it.sourcePage,
      }));
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        if (batch.length > 0) await tx.insert(documentParserItems).values(batch);
      }
    });

    // Mirror page text into Postgres for full-text search.
    await replacePages(db, doc.id, result.pageTexts);

    // Mode B — narrative documents have no pay-item schedule, so `items` above
    // is (near) empty. Read scope from the specs/drawings against the trade
    // scope checklist instead (a cheap text-only pass over the page text we
    // already have — no re-OCR). Mode A (schedule) docs skip this entirely.
    let scopeCostUsd = 0;
    if (result.shape.shape === 'narrative') {
      const scope = await extractScope({
        vision,
        model,
        pricing: pricingFor(model),
        taxonomy,
        pageTexts: result.pageTexts,
        logger: ctx.logger,
        logId: doc.id,
      });
      scopeCostUsd = scope.costUsd;
      await db.transaction(async (tx) => {
        await tx
          .delete(documentParserScopeFindings)
          .where(eq(documentParserScopeFindings.documentId, doc.id));
        if (scope.findings.length > 0) {
          await tx.insert(documentParserScopeFindings).values(
            scope.findings.map((f) => ({
              documentId: doc.id,
              item: f.item,
              status: f.status,
              citations: f.citations,
            })),
          );
        }
      });
      ctx.logger.info(
        { documentId: doc.id, findings: scope.findings.length, covered: scope.coveredCount, costUsd: scope.costUsd },
        'document-parser.parse.scope',
      );
    }

    const totalCostUsd = Number((result.costUsd + scopeCostUsd).toFixed(4));

    await db
      .update(documentParserDocuments)
      .set({
        status: 'parsed',
        pageCount: result.pageCount,
        shape: result.shape.shape,
        costUsd: num(totalCostUsd),
        parsedAt: new Date(),
        suggestedTitle: meta.title,
        jurisdiction: meta.jurisdiction ?? doc.jurisdiction,
        error: null,
      })
      .where(eq(documentParserDocuments.id, doc.id));

    ctx.logger.info(
      {
        documentId: doc.id,
        shape: result.shape.shape,
        items: result.items.length,
        pages: result.pageCount,
        visionPages: result.visionPages,
        textPages: result.textPages,
        costUsd: totalCostUsd,
      },
      'document-parser.parse.parsed',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error({ documentId: doc.id, err: message }, 'document-parser.parse.failed');
    await db
      .update(documentParserDocuments)
      .set({ status: 'failed', error: message.slice(0, MAX_ERROR_LEN) })
      .where(eq(documentParserDocuments.id, doc.id));
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};
