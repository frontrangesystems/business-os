import { describe, expect, it } from 'vitest';

import { summarizePipeline } from '../src/server/index.js';

/**
 * Pipeline funnel + win rate (Phase 2 item 6). `summarizePipeline` turns
 * per-status counts into the funnel the panel shows. `found` is every bid,
 * `reviewed` is everything off `new`, and win rate is over decided bids only.
 */
describe('summarizePipeline', () => {
  it('derives the funnel and win rate from status counts', () => {
    const s = summarizePipeline({ new: 10, pursuing: 4, submitted: 3, won: 2, lost: 1 });
    expect(s.funnel).toEqual({
      found: 20,
      reviewed: 10, // 20 total − 10 still new
      pursuing: 4,
      submitted: 3,
      won: 2,
      lost: 1,
    });
    expect(s.winRate).toBe(0.667); // 2 / (2 + 1), 3dp
  });

  it('returns winRate null when no bids are decided', () => {
    const s = summarizePipeline({ new: 5, pursuing: 2, submitted: 1 });
    expect(s.winRate).toBeNull();
    expect(s.funnel.found).toBe(8);
    expect(s.funnel.reviewed).toBe(3);
  });

  it('handles an all-won set as a 100% win rate', () => {
    const s = summarizePipeline({ won: 4 });
    expect(s.winRate).toBe(1);
    expect(s.funnel).toMatchObject({ found: 4, reviewed: 4, won: 4, lost: 0 });
  });

  it('treats unknown/absent statuses as zero and an empty set as all-zero', () => {
    const empty = summarizePipeline({});
    expect(empty.funnel).toEqual({ found: 0, reviewed: 0, pursuing: 0, submitted: 0, won: 0, lost: 0 });
    expect(empty.winRate).toBeNull();
    // A status outside the funnel (e.g. reported_missed) still counts toward found/reviewed.
    const withOther = summarizePipeline({ new: 1, reported_missed: 2 });
    expect(withOther.funnel.found).toBe(3);
    expect(withOther.funnel.reviewed).toBe(2);
  });
});
