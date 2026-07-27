import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseDocument, extractMeta } from '../src/parse.js';
import { CONSTRUCTION_BID_TAXONOMY } from '../src/taxonomy.js';
import { OPUS_4_8_PRICING } from '../src/config.js';
import type { Logger } from '../src/types.js';
import type { VisionLlmClient, LlmCompletionRequest } from '../src/vision-client.js';
import { buildPdf } from './_pdf.js';

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/**
 * A fake VisionLlmClient that returns canned JSON based on which prompt it sees:
 *  - image present  -> vision OCR reply (plan sheet, curb item)
 *  - cover/meta text -> title/jurisdiction reply
 *  - otherwise (text-layer extraction) -> bid-summary reply (sodding item)
 * It records every call so tests can assert the path taken (e.g. tiling).
 */
function makeFakeClient(): { client: VisionLlmClient; calls: LlmCompletionRequest[] } {
  const calls: LlmCompletionRequest[] = [];
  const client: VisionLlmClient = {
    async complete(req) {
      calls.push(req);
      if (req.images && req.images.length > 0) {
        return {
          text: JSON.stringify({
            page_type: 'plan_sheet',
            ocr_text: 'CURB AND GUTTER DETAIL SHEET',
            bid_items: [
              { description: 'Curb and Gutter', item_code: '702-01', unit: 'LNFT', quantity: 1200 },
            ],
          }),
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      if (req.text.includes('cover/summary text')) {
        return {
          text: JSON.stringify({ title: 'LA 1 Widening', jurisdiction: 'Iberville Parish' }),
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        text: JSON.stringify({
          page_type: 'bid_summary',
          bid_items: [
            { description: 'Slab Sodding', item_code: '714-01', unit: 'SQYD', quantity: 500 },
          ],
        }),
        usage: { inputTokens: 200, outputTokens: 80 },
      };
    },
  };
  return { client, calls };
}

// A text-heavy page (>100 non-ws chars => text-layer path) + an empty page
// (no text => image-only / vision path).
const SCHEDULE_LINES = [
  'SCHEDULE OF ITEMS - PROJECT LA 1 WIDENING',
  '714-01-00600  Slab Sodding (St. Augustine)  500 SQYD',
  '702-01-00100  Curb and Gutter Type A  1200 LNFT',
  'This cover page has ample text so the text layer exceeds the threshold.',
];

describe('parseDocument (real poppler + fake vision client)', () => {
  let tmp: string;
  let pdfPath: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ext-engine-test-'));
    pdfPath = join(tmp, 'sample.pdf');
    await writeFile(pdfPath, buildPdf([SCHEDULE_LINES, []]));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('parses both the text-layer and image-only pages', async () => {
    const { client } = makeFakeClient();
    const res = await parseDocument({
      pdfPath,
      tmpDir: tmp,
      vision: client,
      model: 'claude-opus-4-8',
      pricing: OPUS_4_8_PRICING,
      taxonomy: CONSTRUCTION_BID_TAXONOMY,
      logger: silentLogger,
    });

    expect(res.pageCount).toBe(2);
    expect(res.textPages).toBe(1);
    expect(res.visionPages).toBe(1);
    expect(res.pages).toHaveLength(2);

    // One item from each page, deduped to two distinct items.
    const descriptions = res.items.map((i) => i.description).sort();
    expect(descriptions).toEqual(['Curb and Gutter', 'Slab Sodding']);

    // Quantity is captured (the headline fix for a takeoff product).
    const sodding = res.items.find((i) => i.description === 'Slab Sodding');
    expect(sodding?.quantity).toBe(500);
    expect(sodding?.unit).toBe('SQYD');
    const curb = res.items.find((i) => i.description === 'Curb and Gutter');
    expect(curb?.quantity).toBe(1200);

    // The bid_summary page is detected as the summary page.
    expect(res.summaryPages).toContain(1);

    // Cost is derived from usage × pricing: (300 in + 130 out) tokens.
    const expected = (300 / 1e6) * 5 + (130 / 1e6) * 25;
    expect(res.costUsd).toBeCloseTo(expected, 4);
    expect(res.inputTokens).toBe(300);
    expect(res.outputTokens).toBe(130);
  });

  it('dedups repeated items across pages by description + code', async () => {
    // Both pages "see" the same item -> collapses to one.
    const dupPdf = join(tmp, 'dup.pdf');
    await writeFile(dupPdf, buildPdf([SCHEDULE_LINES, SCHEDULE_LINES]));
    const client: VisionLlmClient = {
      async complete() {
        return {
          text: JSON.stringify({
            page_type: 'bid_summary',
            bid_items: [{ description: 'Slab Sodding', item_code: '714-01', unit: 'SQYD', quantity: 500 }],
          }),
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };
    const res = await parseDocument({
      pdfPath: dupPdf,
      tmpDir: tmp,
      vision: client,
      model: 'claude-opus-4-8',
      pricing: OPUS_4_8_PRICING,
      taxonomy: CONSTRUCTION_BID_TAXONOMY,
      logger: silentLogger,
    });
    expect(res.items).toHaveLength(1);
  });

  it('tiles an image-only page when the render exceeds the px cap', async () => {
    const { client, calls } = makeFakeClient();
    const res = await parseDocument({
      pdfPath,
      tmpDir: tmp,
      vision: client,
      model: 'claude-opus-4-8',
      pricing: OPUS_4_8_PRICING,
      taxonomy: CONSTRUCTION_BID_TAXONOMY,
      // Force tiling: a tiny cap means even a floor-DPI render is oversized.
      tuning: { maxImagePx: 200 },
      logger: silentLogger,
      pageSubset: [2], // the image-only page only
    });

    // The single image-only page produced multiple vision (tile) calls.
    const visionCalls = calls.filter((c) => (c.images?.length ?? 0) > 0);
    expect(visionCalls.length).toBeGreaterThan(1);
    // Items from tiles still land.
    expect(res.items.some((i) => i.description === 'Curb and Gutter')).toBe(true);
    expect(res.visionPages).toBe(1);
  });
});

describe('extractMeta', () => {
  it('pulls a title + jurisdiction from cover text', async () => {
    const { client } = makeFakeClient();
    const meta = await extractMeta({
      vision: client,
      model: 'claude-opus-4-8',
      taxonomy: CONSTRUCTION_BID_TAXONOMY,
      pageTexts: new Map([[1, 'LA 1 Widening — Iberville Parish DOTD project cover sheet text']]),
      summaryPages: [1],
      logger: silentLogger,
    });
    expect(meta.title).toBe('LA 1 Widening');
    expect(meta.jurisdiction).toBe('Iberville Parish');
  });

  it('returns nulls when there is too little text', async () => {
    const { client } = makeFakeClient();
    const meta = await extractMeta({
      vision: client,
      model: 'claude-opus-4-8',
      taxonomy: CONSTRUCTION_BID_TAXONOMY,
      pageTexts: new Map([[1, 'short']]),
      summaryPages: [],
      logger: silentLogger,
    });
    expect(meta).toEqual({ title: null, jurisdiction: null });
  });
});
