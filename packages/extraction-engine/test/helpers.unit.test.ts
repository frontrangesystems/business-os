import { describe, expect, it } from 'vitest';

import { sanitizeItems, toQuantity, parseJsonReply, nonWhitespaceLen } from '../src/util.js';
import { dpiForPage } from '../src/pdf.js';
import { resolveTuning } from '../src/config.js';
import {
  CONSTRUCTION_BID_TAXONOMY,
  visionPrompt,
  textPrompt,
  type ExtractionTaxonomy,
} from '../src/taxonomy.js';

describe('toQuantity', () => {
  it('passes finite numbers through', () => {
    expect(toQuantity(500)).toBe(500);
    expect(toQuantity(0)).toBe(0);
    expect(toQuantity(12.5)).toBe(12.5);
  });
  it('parses numeric-ish strings and strips units/commas', () => {
    expect(toQuantity('1,200')).toBe(1200);
    expect(toQuantity('1200 SQYD')).toBe(1200);
    expect(toQuantity('  42 ')).toBe(42);
  });
  it('returns null for empty / non-numeric / non-finite', () => {
    expect(toQuantity('')).toBeNull();
    expect(toQuantity('   ')).toBeNull();
    expect(toQuantity('lump sum')).toBeNull();
    expect(toQuantity(null)).toBeNull();
    expect(toQuantity(undefined)).toBeNull();
    expect(toQuantity(NaN)).toBeNull();
  });
});

describe('sanitizeItems', () => {
  it('captures quantity alongside description/code/unit', () => {
    const items = sanitizeItems([
      { description: 'Slab Sodding', item_code: '714-01', unit: 'SQYD', quantity: 500 },
    ]);
    expect(items).toEqual([
      { description: 'Slab Sodding', itemCode: '714-01', unit: 'SQYD', quantity: 500 },
    ]);
  });
  it('defaults missing fields to null and drops blank descriptions', () => {
    const items = sanitizeItems([
      { description: 'Curb' },
      { description: '   ' },
      { item_code: 'x' },
      'nope',
    ]);
    expect(items).toEqual([
      { description: 'Curb', itemCode: null, unit: null, quantity: null },
    ]);
  });
  it('returns [] for non-arrays', () => {
    expect(sanitizeItems(null)).toEqual([]);
    expect(sanitizeItems({})).toEqual([]);
  });
});

describe('parseJsonReply', () => {
  it('parses fenced JSON', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('parses bare JSON', () => {
    expect(parseJsonReply('{"a":2}')).toEqual({ a: 2 });
  });
  it('returns null on garbage', () => {
    expect(parseJsonReply('not json')).toBeNull();
  });
});

describe('nonWhitespaceLen', () => {
  it('counts non-whitespace characters only', () => {
    expect(nonWhitespaceLen('a b\tc\n')).toBe(3);
  });
});

describe('dpiForPage', () => {
  const tuning = resolveTuning();
  it('uses default DPI for normal letter pages', () => {
    expect(dpiForPage({ widthPt: 612, heightPt: 792 }, tuning)).toBe(tuning.dpi);
  });
  it('reduces DPI for oversized sheets so the render stays under the px cap', () => {
    const dpi = dpiForPage({ widthPt: 2448, heightPt: 3456 }, tuning); // 34x48 inch
    expect(dpi).toBeLessThan(tuning.dpi);
    expect((3456 / 72) * dpi).toBeLessThanOrEqual(tuning.maxImagePx);
  });
  it('never drops below the 36 DPI floor', () => {
    const dpi = dpiForPage({ widthPt: 100000, heightPt: 100000 }, tuning);
    expect(dpi).toBe(36);
  });
});

describe('taxonomy prompts', () => {
  it('injects the domain description and page types', () => {
    const p = visionPrompt(CONSTRUCTION_BID_TAXONOMY);
    expect(p).toContain('Louisiana DOTD');
    expect(p).toContain('bid_summary');
  });
  it('asks for quantity when captureQuantity is on', () => {
    expect(visionPrompt(CONSTRUCTION_BID_TAXONOMY)).toContain('quantity');
    expect(textPrompt(CONSTRUCTION_BID_TAXONOMY)).toContain('quantity');
  });
  it('omits quantity from the item spec when captureQuantity is off', () => {
    const t: ExtractionTaxonomy = { ...CONSTRUCTION_BID_TAXONOMY, captureQuantity: false };
    expect(visionPrompt(t)).toContain('{description, item_code, unit}');
    expect(visionPrompt(t)).not.toContain('{description, item_code, unit, quantity}');
  });
  it('is parameterized for a different company/domain', () => {
    const asphalt: ExtractionTaxonomy = {
      documentDescription: 'asphalt paving estimate',
      pageTypes: ['summary', 'detail'],
      itemGuidance: 'tonnage items',
      captureQuantity: true,
    };
    const p = visionPrompt(asphalt);
    expect(p).toContain('asphalt paving estimate');
    expect(p).toContain('summary, detail');
    expect(p).not.toContain('Louisiana');
  });
});
