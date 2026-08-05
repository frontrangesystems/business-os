import { describe, expect, it } from 'vitest';

import { extractScope, canonicalizeItem } from '../src/scope.js';
import type { ExtractionTaxonomy } from '../src/taxonomy.js';
import { OPUS_4_8_PRICING } from '../src/config.js';
import type { Logger } from '../src/types.js';
import type { VisionLlmClient } from '../src/vision-client.js';

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

const CHECKLIST = ['footings', 'slab on grade', 'reinforcing', 'tilt panels'];

function taxonomy(overrides: Partial<ExtractionTaxonomy> = {}): ExtractionTaxonomy {
  return {
    documentDescription: 'building project manual',
    pageTypes: ['spec_sheet', 'plan_sheet'],
    itemGuidance: '',
    captureQuantity: true,
    scopeChecklist: CHECKLIST,
    ...overrides,
  };
}

/** Fake client returning canned `present` arrays keyed by a marker in the text. */
function fakeClient(byPageMarker: Record<string, unknown[]>): VisionLlmClient {
  return {
    async complete(req) {
      const marker = Object.keys(byPageMarker).find((m) => req.text.includes(m));
      const present = marker ? byPageMarker[marker] : [];
      return {
        text: JSON.stringify({ present }),
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
}

describe('canonicalizeItem', () => {
  it('maps exact and loose variants to the checklist entry', () => {
    expect(canonicalizeItem('Footings', CHECKLIST)).toBe('footings');
    expect(canonicalizeItem('SLAB ON GRADE', CHECKLIST)).toBe('slab on grade');
    expect(canonicalizeItem('reinforcing bars', CHECKLIST)).toBe('reinforcing');
  });
  it('drops items not on the checklist', () => {
    expect(canonicalizeItem('elevator pit', CHECKLIST)).toBeNull();
    expect(canonicalizeItem('', CHECKLIST)).toBeNull();
  });
});

describe('extractScope', () => {
  it('aggregates checklist findings across pages with citations, in checklist order', async () => {
    const client = fakeClient({
      'PAGE-A': [
        { item: 'footings', status: 'present', evidence: 'FOUNDATION SCHEDULE F1 4x4x2' },
        { item: 'reinforcing', status: 'present', evidence: '#4 bars grade 60' },
      ],
      'PAGE-B': [
        { item: 'footings', status: 'uncertain', evidence: 'see structural' },
        { item: 'slab on grade', status: 'present', evidence: '4" slab #3 @ 18"' },
        { item: 'chimney', status: 'present', evidence: 'not on checklist — must be dropped' },
      ],
    });

    const res = await extractScope({
      vision: client,
      model: 'test',
      pricing: OPUS_4_8_PRICING,
      taxonomy: taxonomy(),
      pageTexts: new Map([
        [3, 'PAGE-A structural notes ...'],
        [5, 'PAGE-B foundation plan ...'],
      ]),
      logger: silentLogger,
    });

    const items = res.findings.map((f) => f.item);
    // checklist order: footings, slab on grade, reinforcing (tilt panels absent)
    expect(items).toEqual(['footings', 'slab on grade', 'reinforcing']);

    const footings = res.findings.find((f) => f.item === 'footings')!;
    expect(footings.status).toBe('present'); // present (p3) beats uncertain (p5)
    expect(footings.citations.map((c) => c.page)).toEqual([3, 5]);

    // off-checklist "chimney" was dropped
    expect(items).not.toContain('chimney');
    expect(res.coveredCount).toBe(3);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it('is a no-op when no checklist is configured', async () => {
    const res = await extractScope({
      vision: fakeClient({}),
      model: 'test',
      pricing: OPUS_4_8_PRICING,
      taxonomy: taxonomy({ scopeChecklist: [] }),
      pageTexts: new Map([[1, 'some text']]),
      logger: silentLogger,
    });
    expect(res.findings).toEqual([]);
    expect(res.coveredCount).toBe(0);
    expect(res.inputTokens).toBe(0);
  });

  it('skips empty pages', async () => {
    let calls = 0;
    const client: VisionLlmClient = {
      async complete() {
        calls++;
        return { text: JSON.stringify({ present: [] }), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await extractScope({
      vision: client,
      model: 'test',
      pricing: OPUS_4_8_PRICING,
      taxonomy: taxonomy(),
      pageTexts: new Map([
        [1, ''],
        [2, '   '],
        [3, 'real content'],
      ]),
      logger: silentLogger,
    });
    expect(calls).toBe(1); // only page 3
  });
});
