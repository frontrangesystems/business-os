import type { EngineTuning, Pricing } from './config.js';
import { resolveTuning } from './config.js';
import type { ExtractedItem, Logger, ParsedPage, ParseResult } from './types.js';
import type { VisionLlmClient } from './vision-client.js';
import type { ExtractionTaxonomy } from './taxonomy.js';
import { metaPrompt, textPrompt, tileVisionPrompt, visionPrompt } from './taxonomy.js';
import {
  dpiForPage,
  pageCountOf,
  pageDimsOf,
  renderAll,
  textLayer,
} from './pdf.js';
import { extractItemsFromText, ocrPage, type OcrContext } from './ocr.js';
import { mapWithConcurrency, nonWhitespaceLen, parseJsonReply } from './util.js';

export interface ParseDocumentInput {
  /** PDF already on the local filesystem. */
  pdfPath: string;
  /** Writable scratch directory for page/tile renders. */
  tmpDir: string;
  /** Vision-LLM client (default: Anthropic; a fake in tests). */
  vision: VisionLlmClient;
  /** Model id passed to every call (no mutable module global). */
  model: string;
  /** Per-MTok pricing used to compute costUsd. */
  pricing: Pricing;
  /** Per-company extraction taxonomy (prompts + page types + item spec). */
  taxonomy: ExtractionTaxonomy;
  /** Optional render/OCR tuning; sane defaults otherwise. */
  tuning?: EngineTuning;
  logger: Logger;
  /** Optional 1-based page subset (for cheap local verification). */
  pageSubset?: number[];
  /** Stable id used only for log correlation. */
  logId?: string;
}

/**
 * Parse one document end to end: render pages, classify text-layer vs
 * image-only, OCR image-only pages (tiling oversized sheets), extract items
 * from text-layer pages, then collect + dedup pay-items across all pages.
 *
 * Pure with respect to the framework: the only I/O is the PDF on disk and the
 * injected vision client. No DB, no object storage, no ref/match-rule linking
 * (that stays in the consuming module). Per-page failures are isolated so one
 * bad page never aborts the document.
 */
export async function parseDocument(input: ParseDocumentInput): Promise<ParseResult> {
  const { vision, pdfPath, tmpDir, logger, model, pricing, taxonomy } = input;
  const tuning = resolveTuning(input.tuning);
  const logId = input.logId ?? 'parse';

  const ctx: OcrContext = {
    client: vision,
    model,
    tuning,
    prompts: {
      vision: visionPrompt(taxonomy),
      tile: tileVisionPrompt(taxonomy),
      text: textPrompt(taxonomy),
    },
  };

  const pageCount = await pageCountOf(pdfPath);
  const pageDims = await pageDimsOf(pdfPath, pageCount);
  const pages =
    input.pageSubset && input.pageSubset.length > 0
      ? [...input.pageSubset].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b)
      : Array.from({ length: pageCount }, (_, i) => i + 1);

  const renders = await renderAll(pdfPath, tmpDir, pageCount, pageDims, tuning);
  logger.info(
    { logId, pageCount, rendered: renders.size, pages: pages.length },
    'extraction.rendered',
  );

  // Classify each page in the working set: text-layer vs image-only.
  const textPages: number[] = [];
  const visionPages: number[] = [];
  const textLayers = new Map<number, string>();
  for (const p of pages) {
    const txt = await textLayer(pdfPath, p).catch(() => '');
    if (nonWhitespaceLen(txt) >= tuning.textThreshold) {
      textPages.push(p);
      textLayers.set(p, txt);
    } else {
      visionPages.push(p);
    }
  }
  logger.info(
    { logId, textPages: textPages.length, visionPages: visionPages.length },
    'extraction.classified',
  );

  let inputTokens = 0;
  let outputTokens = 0;
  const pageResults = new Map<number, ParsedPage>();

  // Image-only pages -> vision OCR (possibly tiled). Per-page isolation.
  const visionOut = await mapWithConcurrency(visionPages, tuning.concurrency, async (p) => {
    const img = renders.get(p);
    if (!img) return null;
    try {
      const dims = pageDims.get(p);
      return await ocrPage(ctx, img, p, tmpDir, pdfPath, dims, dpiForPage(dims, tuning));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ logId, page: p, err: msg }, 'extraction.page_vision_failed');
      return null;
    }
  });
  for (const r of visionOut) {
    if (!r) continue;
    pageResults.set(r.page.page, r.page);
    inputTokens += r.usage.inputTokens;
    outputTokens += r.usage.outputTokens;
  }

  // Text-layer pages -> cheap text-only item extraction. Per-page isolation.
  const textOut = await mapWithConcurrency(textPages, tuning.concurrency, async (p) => {
    const txt = textLayers.get(p) ?? '';
    try {
      return await extractItemsFromText(ctx, p, txt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ logId, page: p, err: msg }, 'extraction.page_text_failed');
      // Keep the text searchable even if extraction failed.
      return {
        page: {
          page: p,
          pageType: null,
          text: txt,
          source: 'text' as const,
          items: [],
        },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
  });
  for (const r of textOut) {
    if (!r) continue;
    pageResults.set(r.page.page, r.page);
    inputTokens += r.usage.inputTokens;
    outputTokens += r.usage.outputTokens;
  }

  // Best searchable text per page.
  const pageTexts = new Map<number, string>();
  for (const p of pages) pageTexts.set(p, pageResults.get(p)?.text ?? textLayers.get(p) ?? '');

  // Summary page(s): prefer model-labelled bid_summary; else the page with the
  // most items. A hint for page_type only — item collection is not limited here.
  let summaryPages = [...pageResults.entries()]
    .filter(([, v]) => v.pageType === 'bid_summary')
    .map(([p]) => p);
  if (summaryPages.length === 0) {
    let bestPage = -1;
    let bestRows = 0;
    for (const [p, v] of pageResults) {
      if (v.items.length > bestRows) {
        bestRows = v.items.length;
        bestPage = p;
      }
    }
    if (bestPage > 0 && bestRows > 0) summaryPages = [bestPage];
  }
  logger.info({ logId, summaryPages }, 'extraction.summary_pages');

  // Collect pay-items from ALL pages; merge + dedup by (description + code).
  const itemMap = new Map<string, ExtractedItem>();
  for (const [p, v] of pageResults) {
    for (const it of v.items) {
      const key = `${it.description.toLowerCase().replace(/\s+/g, ' ').trim()}|${(it.itemCode ?? '').toLowerCase().trim()}`;
      if (!itemMap.has(key)) {
        itemMap.set(key, { ...it, sourcePage: p });
      }
    }
  }
  const items = [...itemMap.values()];
  logger.info({ logId, items: items.length }, 'extraction.items');

  const costUsd = Number(
    (
      (inputTokens / 1_000_000) * pricing.inputUsdPerMTok +
      (outputTokens / 1_000_000) * pricing.outputUsdPerMTok
    ).toFixed(4),
  );

  // Pages, sorted, for a stable output shape.
  const parsedPages: ParsedPage[] = [...pageResults.values()].sort((a, b) => a.page - b.page);

  return {
    items,
    pages: parsedPages,
    pageTexts,
    summaryPages: summaryPages.sort((a, b) => a - b),
    pageCount,
    visionPages: visionPages.length,
    textPages: textPages.length,
    costUsd,
    inputTokens,
    outputTokens,
  };
}

export interface DocumentMeta {
  title: string | null;
  jurisdiction: string | null;
}

/**
 * Extract a human-friendly project title (+ jurisdiction) from the document's
 * cover/summary text. One cheap text-only call; failures are non-fatal. Kept
 * out of parseDocument so a consumer can skip it or call it separately.
 */
export async function extractMeta(input: {
  vision: VisionLlmClient;
  model: string;
  taxonomy: ExtractionTaxonomy;
  pageTexts: Map<number, string>;
  summaryPages: number[];
  logger: Pick<Logger, 'warn'>;
}): Promise<DocumentMeta> {
  const { vision, model, taxonomy, pageTexts, summaryPages, logger } = input;
  const cover = pageTexts.get(1) ?? '';
  const summary = (summaryPages[0] && pageTexts.get(summaryPages[0])) || '';
  const sample = `${cover}\n\n${summary}`.trim().slice(0, 4000);
  if (sample.length < 20) return { title: null, jurisdiction: null };

  const clean = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length > 0 && t.toLowerCase() !== 'null' ? t.slice(0, 120) : null;
  };

  try {
    const { text } = await vision.complete({
      model,
      maxTokens: 300,
      text: `${metaPrompt(taxonomy)}${sample}`,
    });
    const parsed = parseJsonReply(text) as
      | { title?: unknown; jurisdiction?: unknown }
      | null;
    return { title: clean(parsed?.title), jurisdiction: clean(parsed?.jurisdiction) };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'extraction.meta_failed',
    );
    return { title: null, jurisdiction: null };
  }
}
