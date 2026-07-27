import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedTuning } from './config.js';
import type { PayItem, ParsedPage } from './types.js';
import { OversizeImageError, type VisionLlmClient } from './vision-client.js';
import { renderTile, type PageDims } from './pdf.js';
import { parseJsonReply, sanitizeItems } from './util.js';

/** Prompts + model + tuning threaded through the OCR helpers. */
export interface OcrContext {
  client: VisionLlmClient;
  model: string;
  tuning: ResolvedTuning;
  prompts: { vision: string; tile: string; text: string };
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Vision OCR for a single already-within-limits image. */
async function ocrImage(
  ctx: OcrContext,
  imgPath: string,
  prompt: string,
): Promise<{ parsed: unknown; usage: Usage }> {
  const b64 = (await readFile(imgPath)).toString('base64');
  const { text, usage } = await ctx.client.complete({
    model: ctx.model,
    maxTokens: ctx.tuning.maxTokens,
    text: prompt,
    images: [{ mediaType: 'image/jpeg', dataBase64: b64 }],
  });
  return { parsed: parseJsonReply(text), usage };
}

/** Pixel dimensions of a page render at `dpi`. */
function pxDims(dims: PageDims | undefined, dpi: number): { widthPx: number; heightPx: number } {
  return {
    widthPx: Math.round(((dims?.widthPt ?? 612) / 72) * dpi),
    heightPx: Math.round(((dims?.heightPt ?? 792) / 72) * dpi),
  };
}

/**
 * Vision OCR for one page. If the render's longest side exceeds the px cap the
 * page is TILED into an overlapping grid, each tile OCR'd and the text
 * concatenated. A belt-and-suspenders catch also tiles if the provider still
 * rejects the image for size (OversizeImageError).
 */
export async function ocrPage(
  ctx: OcrContext,
  imgPath: string,
  page: number,
  tmpDir: string,
  pdfPath: string,
  dims: PageDims | undefined,
  dpi: number,
): Promise<{ page: ParsedPage; usage: Usage }> {
  const { widthPx, heightPx } = pxDims(dims, dpi);
  const longest = Math.max(widthPx, heightPx);

  if (longest <= ctx.tuning.maxImagePx) {
    let res: { parsed: unknown; usage: Usage };
    try {
      res = await ocrImage(ctx, imgPath, ctx.prompts.vision);
    } catch (err) {
      if (!(err instanceof OversizeImageError)) throw err;
      return ocrPageTiled(ctx, page, tmpDir, pdfPath, dims, dpi);
    }
    const p = res.parsed as {
      page_type?: unknown;
      ocr_text?: unknown;
      bid_items?: unknown;
    } | null;
    return {
      page: {
        page,
        pageType: typeof p?.page_type === 'string' ? p.page_type : null,
        text: typeof p?.ocr_text === 'string' ? p.ocr_text : '',
        source: 'vision',
        items: sanitizeItems(p?.bid_items),
      },
      usage: res.usage,
    };
  }

  return ocrPageTiled(ctx, page, tmpDir, pdfPath, dims, dpi);
}

/**
 * Tile a large page into an overlapping grid and OCR each tile. Tiles render
 * straight from the PDF (poppler crop in device px), so we never materialize a
 * single over-the-limit image. The grid keeps each tile's longest side <=
 * maxImagePx, bounded by maxTilesPerPage.
 */
async function ocrPageTiled(
  ctx: OcrContext,
  page: number,
  tmpDir: string,
  pdfPath: string,
  dims: PageDims | undefined,
  dpi: number,
): Promise<{ page: ParsedPage; usage: Usage }> {
  const { widthPx, heightPx } = pxDims(dims, dpi);
  const { maxImagePx, maxTilesPerPage, tileOverlapPx } = ctx.tuning;

  const cols = Math.min(3, Math.max(1, Math.ceil(widthPx / maxImagePx)));
  const rows = Math.min(
    Math.max(1, Math.floor(maxTilesPerPage / cols)),
    Math.max(1, Math.ceil(heightPx / maxImagePx)),
  );
  const tileW = Math.ceil(widthPx / cols);
  const tileH = Math.ceil(heightPx / rows);

  let pageType: string | null = null;
  const texts: string[] = [];
  const items: PayItem[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.max(0, c * tileW - tileOverlapPx);
      const y = Math.max(0, r * tileH - tileOverlapPx);
      const w = Math.min(widthPx - x, tileW + tileOverlapPx * 2);
      const h = Math.min(heightPx - y, tileH + tileOverlapPx * 2);
      const prefix = join(tmpDir, `pg${page}-tile-${r}-${c}`);
      const tilePath = await renderTile(pdfPath, page, dpi, { x, y, w, h }, prefix);
      const { parsed, usage } = await ocrImage(ctx, tilePath, ctx.prompts.tile);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      const p = parsed as {
        page_type?: unknown;
        ocr_text?: unknown;
        bid_items?: unknown;
      } | null;
      if (!pageType && typeof p?.page_type === 'string') pageType = p.page_type;
      if (typeof p?.ocr_text === 'string' && p.ocr_text.trim()) texts.push(p.ocr_text);
      items.push(...sanitizeItems(p?.bid_items));
    }
  }

  return {
    page: { page, pageType, text: texts.join('\n'), source: 'vision', items },
    usage: { inputTokens, outputTokens },
  };
}

/**
 * Cheap, text-only pay-item extraction for a page that already has a text
 * layer. No image is sent, so it captures the text-based schedule without
 * paying for vision. The searchable text is the verbatim text layer.
 */
export async function extractItemsFromText(
  ctx: OcrContext,
  page: number,
  pageText: string,
): Promise<{ page: ParsedPage; usage: Usage }> {
  const { text, usage } = await ctx.client.complete({
    model: ctx.model,
    maxTokens: ctx.tuning.maxTokens,
    text: `${ctx.prompts.text}${pageText}`,
  });
  const parsed = parseJsonReply(text) as {
    page_type?: unknown;
    bid_items?: unknown;
  } | null;
  return {
    page: {
      page,
      pageType: typeof parsed?.page_type === 'string' ? parsed.page_type : null,
      text: pageText,
      source: 'text',
      items: sanitizeItems(parsed?.bid_items),
    },
    usage,
  };
}
