import { describe, expect, it } from 'vitest';

import { detectDocumentShape } from '../src/shape.js';
import type { ParsedPage } from '../src/types.js';

/** Build N items, `withQty` of them carrying a numeric quantity. */
function items(total: number, withQty: number): { quantity: number | null }[] {
  return Array.from({ length: total }, (_, i) => ({
    quantity: i < withQty ? 100 + i : null,
  }));
}

function pages(types: (string | null)[]): Pick<ParsedPage, 'pageType'>[] {
  return types.map((pageType) => ({ pageType }));
}

describe('detectDocumentShape', () => {
  it('classifies a genuine schedule (many populated quantities) as schedule', () => {
    const s = detectDocumentShape({
      items: items(30, 28),
      pages: pages(['bid_summary', 'spec_sheet', 'plan_sheet']),
      captureQuantity: true,
    });
    expect(s.shape).toBe('schedule');
    expect(s.quantifiedItems).toBe(28);
    expect(s.reason).toMatch(/populated quantities/);
  });

  it('classifies a unit-price form (few rows, no quantities) as narrative', () => {
    // The mo-barracks failure: a 3-row Unit Prices Form with item + unit but no
    // quantities must NOT be mistaken for the schedule of work.
    const s = detectDocumentShape({
      items: items(3, 0),
      pages: pages(['spec_sheet', 'spec_sheet', 'plan_sheet']),
      captureQuantity: true,
    });
    expect(s.shape).toBe('narrative');
    expect(s.quantifiedItems).toBe(0);
  });

  it('treats a labelled bid_summary page with enough rows as a schedule even when quantities are sparse', () => {
    const s = detectDocumentShape({
      items: items(8, 1),
      pages: pages(['bid_summary', 'misc']),
      captureQuantity: true,
    });
    expect(s.shape).toBe('schedule');
    expect(s.reason).toMatch(/bid_summary page/);
  });

  it('falls back to the labelled-page signal when quantity capture is off', () => {
    const s = detectDocumentShape({
      items: items(12, 0),
      pages: pages(['bid_summary', 'plan_sheet']),
      captureQuantity: false,
    });
    expect(s.shape).toBe('schedule');
  });

  it('classifies a building set (no schedule, no quantities) as narrative', () => {
    const s = detectDocumentShape({
      items: items(4, 0),
      pages: pages(['spec_sheet', 'plan_sheet', 'callouts', 'plan_sheet']),
      captureQuantity: true,
    });
    expect(s.shape).toBe('narrative');
  });

  it('classifies an empty document as narrative', () => {
    const s = detectDocumentShape({ items: [], pages: pages([]), captureQuantity: true });
    expect(s.shape).toBe('narrative');
    expect(s.totalItems).toBe(0);
  });

  it('honours a custom threshold', () => {
    const base = { items: items(4, 4), pages: pages(['plan_sheet']), captureQuantity: true };
    expect(detectDocumentShape(base).shape).toBe('narrative'); // 4 < default 5
    expect(detectDocumentShape({ ...base, minQuantifiedItems: 3 }).shape).toBe('schedule');
  });
});
