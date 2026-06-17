import { describe, it, expect } from 'vitest';
import {
  friendlyToCron,
  cronToFriendly,
  describeSchedule,
  nextRun,
  formatTime12h,
  FriendlyScheduleSchema,
  type FriendlySchedule,
} from '../src/schedule.js';

describe('friendlyToCron', () => {
  it('interval minutes', () => {
    expect(friendlyToCron({ kind: 'interval', every: 'minute', n: 15 })).toBe('*/15 * * * *');
    expect(friendlyToCron({ kind: 'interval', every: 'minute', n: 30 })).toBe('*/30 * * * *');
    expect(friendlyToCron({ kind: 'interval', every: 'minute', n: 1 })).toBe('* * * * *');
  });

  it('interval hours', () => {
    expect(friendlyToCron({ kind: 'interval', every: 'hour', n: 1 })).toBe('0 * * * *');
    expect(friendlyToCron({ kind: 'interval', every: 'hour', n: 6 })).toBe('0 */6 * * *');
  });

  it('daily', () => {
    expect(friendlyToCron({ kind: 'daily', at: '08:00' })).toBe('0 8 * * *');
    expect(friendlyToCron({ kind: 'daily', at: '09:30' })).toBe('30 9 * * *');
    expect(friendlyToCron({ kind: 'daily', at: '00:00' })).toBe('0 0 * * *');
    expect(friendlyToCron({ kind: 'daily', at: '23:59' })).toBe('59 23 * * *');
  });

  it('weekly', () => {
    expect(friendlyToCron({ kind: 'weekly', day: 1, at: '09:00' })).toBe('0 9 * * 1');
    expect(friendlyToCron({ kind: 'weekly', day: 0, at: '17:15' })).toBe('15 17 * * 0');
    expect(friendlyToCron({ kind: 'weekly', day: 6, at: '23:00' })).toBe('0 23 * * 6');
  });

  it('cron passthrough', () => {
    expect(friendlyToCron({ kind: 'cron', expr: '5 4 * * 2' })).toBe('5 4 * * 2');
  });

  it('throws for manual + event (no cron form)', () => {
    expect(() => friendlyToCron({ kind: 'manual' })).toThrow();
    expect(() => friendlyToCron({ kind: 'event', topic: 'mail.received' })).toThrow();
  });

  it('rejects out-of-range interval values', () => {
    expect(() => friendlyToCron({ kind: 'interval', every: 'minute', n: 60 })).toThrow();
    expect(() => friendlyToCron({ kind: 'interval', every: 'hour', n: 24 })).toThrow();
    expect(() => friendlyToCron({ kind: 'interval', every: 'minute', n: 0 })).toThrow();
  });
});

describe('cronToFriendly', () => {
  it('recognises interval minutes', () => {
    expect(cronToFriendly('*/15 * * * *')).toEqual({ kind: 'interval', every: 'minute', n: 15 });
    expect(cronToFriendly('* * * * *')).toEqual({ kind: 'interval', every: 'minute', n: 1 });
  });

  it('recognises interval hours', () => {
    expect(cronToFriendly('0 */6 * * *')).toEqual({ kind: 'interval', every: 'hour', n: 6 });
    expect(cronToFriendly('0 * * * *')).toEqual({ kind: 'interval', every: 'hour', n: 1 });
  });

  it('recognises daily', () => {
    expect(cronToFriendly('0 8 * * *')).toEqual({ kind: 'daily', at: '08:00' });
    expect(cronToFriendly('30 9 * * *')).toEqual({ kind: 'daily', at: '09:30' });
  });

  it('recognises weekly', () => {
    expect(cronToFriendly('0 9 * * 1')).toEqual({ kind: 'weekly', day: 1, at: '09:00' });
    expect(cronToFriendly('15 17 * * 0')).toEqual({ kind: 'weekly', day: 0, at: '17:15' });
  });

  it('returns null for unrecognised patterns', () => {
    expect(cronToFriendly('0 9 1 * *')).toBeNull(); // day-of-month set
    expect(cronToFriendly('0 9 * 6 *')).toBeNull(); // month set
    expect(cronToFriendly('0 9 * * 1-5')).toBeNull(); // dow range
    expect(cronToFriendly('15,45 * * * *')).toBeNull(); // minute list
    expect(cronToFriendly('not a cron')).toBeNull();
    expect(cronToFriendly('* * * *')).toBeNull(); // wrong field count
    expect(cronToFriendly('0 9 * * * *')).toBeNull(); // 6 fields
  });
});

describe('friendlyToCron / cronToFriendly round-trip', () => {
  const cases: FriendlySchedule[] = [
    { kind: 'interval', every: 'minute', n: 1 },
    { kind: 'interval', every: 'minute', n: 15 },
    { kind: 'interval', every: 'minute', n: 30 },
    { kind: 'interval', every: 'hour', n: 1 },
    { kind: 'interval', every: 'hour', n: 6 },
    { kind: 'daily', at: '08:00' },
    { kind: 'daily', at: '23:59' },
    { kind: 'weekly', day: 1, at: '09:00' },
    { kind: 'weekly', day: 0, at: '00:00' },
  ];
  for (const c of cases) {
    it(`round-trips ${JSON.stringify(c)}`, () => {
      expect(cronToFriendly(friendlyToCron(c))).toEqual(c);
    });
  }
});

describe('describeSchedule', () => {
  it('friendly objects', () => {
    expect(describeSchedule({ kind: 'manual' })).toBe('Manual — runs only when triggered');
    expect(describeSchedule({ kind: 'event', topic: 'mail.received' })).toBe(
      'When "mail.received" happens',
    );
    expect(describeSchedule({ kind: 'interval', every: 'minute', n: 15 })).toBe('Every 15 minutes');
    expect(describeSchedule({ kind: 'interval', every: 'minute', n: 1 })).toBe('Every minute');
    expect(describeSchedule({ kind: 'interval', every: 'hour', n: 6 })).toBe('Every 6 hours');
    expect(describeSchedule({ kind: 'interval', every: 'hour', n: 1 })).toBe('Every hour');
    expect(describeSchedule({ kind: 'daily', at: '08:00' })).toBe('Daily at 8:00 AM');
    expect(describeSchedule({ kind: 'daily', at: '13:30' })).toBe('Daily at 1:30 PM');
    expect(describeSchedule({ kind: 'weekly', day: 1, at: '09:00' })).toBe(
      'Weekly on Monday at 9:00 AM',
    );
  });

  it('raw cron strings get friendly labels when recognised', () => {
    expect(describeSchedule('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeSchedule('0 */6 * * *')).toBe('Every 6 hours');
    expect(describeSchedule('0 8 * * *')).toBe('Daily at 8:00 AM');
    expect(describeSchedule('0 9 * * 1')).toBe('Weekly on Monday at 9:00 AM');
  });

  it('unrecognised cron never says the word "cron" as a prefix', () => {
    const label = describeSchedule('0 9 1 * *');
    expect(label).toBe('Custom schedule (0 9 1 * *)');
    expect(label.toLowerCase().startsWith('cron')).toBe(false);
  });
});

describe('formatTime12h', () => {
  it('formats midnight, noon, and afternoon', () => {
    expect(formatTime12h('00:00')).toBe('12:00 AM');
    expect(formatTime12h('12:00')).toBe('12:00 PM');
    expect(formatTime12h('09:05')).toBe('9:05 AM');
    expect(formatTime12h('23:59')).toBe('11:59 PM');
  });
});

describe('nextRun', () => {
  it('computes next daily fire', () => {
    const from = new Date('2026-06-16T07:00:00Z');
    const next = nextRun({ kind: 'daily', at: '08:00' }, from);
    expect(next?.toISOString()).toBe('2026-06-16T08:00:00.000Z');
  });

  it('rolls to next day when time already passed', () => {
    const from = new Date('2026-06-16T09:00:00Z');
    const next = nextRun({ kind: 'daily', at: '08:00' }, from);
    expect(next?.toISOString()).toBe('2026-06-17T08:00:00.000Z');
  });

  it('computes next interval fire', () => {
    const from = new Date('2026-06-16T07:02:00Z');
    const next = nextRun({ kind: 'interval', every: 'minute', n: 15 }, from);
    expect(next?.toISOString()).toBe('2026-06-16T07:15:00.000Z');
  });

  it('computes next weekly fire', () => {
    // 2026-06-16 is a Tuesday. Next Monday (day 1) is 2026-06-22.
    const from = new Date('2026-06-16T07:00:00Z');
    const next = nextRun({ kind: 'weekly', day: 1, at: '09:00' }, from);
    expect(next?.toISOString()).toBe('2026-06-22T09:00:00.000Z');
  });

  it('accepts a raw cron string', () => {
    const from = new Date('2026-06-16T07:00:00Z');
    const next = nextRun('0 8 * * *', from);
    expect(next?.toISOString()).toBe('2026-06-16T08:00:00.000Z');
  });

  it('returns null for manual + event', () => {
    expect(nextRun({ kind: 'manual' })).toBeNull();
    expect(nextRun({ kind: 'event', topic: 't' })).toBeNull();
  });
});

describe('FriendlyScheduleSchema', () => {
  it('accepts valid shapes', () => {
    expect(FriendlyScheduleSchema.safeParse({ kind: 'manual' }).success).toBe(true);
    expect(
      FriendlyScheduleSchema.safeParse({ kind: 'interval', every: 'hour', n: 6 }).success,
    ).toBe(true);
    expect(FriendlyScheduleSchema.safeParse({ kind: 'daily', at: '08:00' }).success).toBe(true);
    expect(
      FriendlyScheduleSchema.safeParse({ kind: 'weekly', day: 3, at: '09:00' }).success,
    ).toBe(true);
    expect(FriendlyScheduleSchema.safeParse({ kind: 'cron', expr: '5 4 * * *' }).success).toBe(true);
  });

  it('rejects invalid shapes', () => {
    expect(FriendlyScheduleSchema.safeParse({ kind: 'daily', at: '25:00' }).success).toBe(false);
    expect(FriendlyScheduleSchema.safeParse({ kind: 'daily', at: '8:00' }).success).toBe(false);
    expect(
      FriendlyScheduleSchema.safeParse({ kind: 'weekly', day: 7, at: '09:00' }).success,
    ).toBe(false);
    expect(
      FriendlyScheduleSchema.safeParse({ kind: 'interval', every: 'minute', n: 0 }).success,
    ).toBe(false);
    expect(
      FriendlyScheduleSchema.safeParse({ kind: 'interval', every: 'day', n: 1 }).success,
    ).toBe(false);
  });
});
