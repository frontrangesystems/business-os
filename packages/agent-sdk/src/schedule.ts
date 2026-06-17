import { z } from 'zod';

/**
 * Human-readable schedule representation. This is the operator-facing way to
 * author and display an agent's trigger. It deliberately avoids cron jargon:
 * the framework translates `FriendlySchedule` to/from a standard 5-field cron
 * expression at the runtime boundary via `friendlyToCron` / `cronToFriendly`,
 * so the scheduler keeps using cron internally while operators never see a raw
 * expression.
 *
 *  - manual:   runs only when an operator clicks "Run now" or another agent
 *              enqueues it.
 *  - event:    runs when a named topic fires inside the runtime's event bus.
 *  - interval: "Every N minutes" / "Every N hours".
 *  - daily:    "Daily at HH:MM" (24h time, UTC).
 *  - weekly:   "Weekly on <Day> at HH:MM" (UTC).
 *  - cron:     ESCAPE HATCH for power users. The friendly UI is the primary way
 *              to author a schedule; this is retained so an arbitrary cron
 *              expression authored elsewhere (or migrated from an old override)
 *              still round-trips and gets a readable label.
 *
 * All times are UTC — the scheduler runs cron jobs in UTC.
 */
export type FriendlySchedule =
  | { kind: 'manual' }
  | { kind: 'event'; topic: string }
  | { kind: 'interval'; every: 'minute' | 'hour'; n: number }
  | { kind: 'daily'; at: string }
  | { kind: 'weekly'; day: number; at: string }
  | { kind: 'cron'; expr: string };

/** Matches a 24-hour `HH:MM` time string (00:00–23:59). */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Zod schema for `FriendlySchedule`. Used by the schedule-override API to
 * validate operator input. Mirrors the type above exactly.
 */
export const FriendlyScheduleSchema: z.ZodType<FriendlySchedule> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('event'), topic: z.string().min(1) }),
  z.object({
    kind: z.literal('interval'),
    every: z.enum(['minute', 'hour']),
    n: z.number().int().min(1).max(59),
  }),
  z.object({ kind: z.literal('daily'), at: z.string().regex(TIME_RE, 'expected HH:MM (24h)') }),
  z.object({
    kind: z.literal('weekly'),
    day: z.number().int().min(0).max(6),
    at: z.string().regex(TIME_RE, 'expected HH:MM (24h)'),
  }),
  z.object({ kind: z.literal('cron'), expr: z.string().min(1) }),
]) as z.ZodType<FriendlySchedule>;

/** Full day names, indexed 0 (Sunday) – 6 (Saturday) to match cron + JS Date. */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function parseTime(at: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(at);
  if (!m) throw new Error(`invalid time "${at}" — expected HH:MM (24h)`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Format an HH:MM (24h) string as a 12-hour clock label, e.g. "9:00 AM". */
export function formatTime12h(at: string): string {
  const { hour, minute } = parseTime(at);
  const period = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${period}`;
}

/**
 * Convert a `FriendlySchedule` to a standard 5-field cron expression (UTC).
 *
 * Throws for `manual` and `event` kinds — those don't have a cron form; the
 * scheduler handles them separately. Callers that may receive either should
 * branch on `kind` first.
 */
export function friendlyToCron(s: FriendlySchedule): string {
  switch (s.kind) {
    case 'cron':
      return s.expr;
    case 'interval': {
      if (!Number.isInteger(s.n) || s.n < 1) {
        throw new Error(`interval n must be a positive integer, got ${s.n}`);
      }
      if (s.every === 'minute') {
        if (s.n > 59) throw new Error('interval minutes must be 1–59 (use hours above that)');
        // "Every n minutes" — */n in the minute field. n=1 → every minute.
        return `${s.n === 1 ? '*' : `*/${s.n}`} * * * *`;
      }
      // every === 'hour'
      if (s.n > 23) throw new Error('interval hours must be 1–23 (use a daily schedule above that)');
      return `0 ${s.n === 1 ? '*' : `*/${s.n}`} * * *`;
    }
    case 'daily': {
      const { hour, minute } = parseTime(s.at);
      return `${minute} ${hour} * * *`;
    }
    case 'weekly': {
      if (!Number.isInteger(s.day) || s.day < 0 || s.day > 6) {
        throw new Error(`weekly day must be 0–6, got ${s.day}`);
      }
      const { hour, minute } = parseTime(s.at);
      return `${minute} ${hour} * * ${s.day}`;
    }
    case 'manual':
      throw new Error('manual schedules have no cron expression');
    case 'event':
      throw new Error('event schedules have no cron expression');
    default: {
      const _exhaustive: never = s;
      throw new Error(`unknown schedule kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Best-effort: recognise a cron expression as one of the friendly kinds so an
 * existing raw-cron override can be shown with friendly controls + label.
 *
 * Returns `null` when the expression doesn't match a known friendly pattern —
 * callers should then fall back to `{ kind: 'cron', expr }` (the escape hatch),
 * which still gets a passthrough label from `describeSchedule`.
 */
export function cronToFriendly(expr: string): FriendlySchedule | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];

  // Day-of-month + month must be wildcard for every friendly kind we model.
  if (dom !== '*' || mon !== '*') return null;

  // Every N minutes: minute field is "*" or "*/n", hour + dow wildcard.
  // (A fixed-minute "0 * * * *" is "every hour" and falls through below.)
  if (hour === '*' && dow === '*' && (min === '*' || /^\*\/\d{1,2}$/.test(min))) {
    if (min === '*') return { kind: 'interval', every: 'minute', n: 1 };
    const n = Number(/^\*\/(\d{1,2})$/.exec(min)![1]);
    if (n >= 1 && n <= 59) return { kind: 'interval', every: 'minute', n };
    return null;
  }

  // Past here the minute field must be a plain integer (a fixed minute mark).
  if (!/^\d{1,2}$/.test(min)) return null;
  const minute = Number(min);
  if (minute > 59) return null;

  // Every N hours: "m */n * * *" or "m * * * *" (every hour) with dow wildcard.
  if (dow === '*') {
    if (hour === '*') return minute === 0 ? { kind: 'interval', every: 'hour', n: 1 } : null;
    const stepHour = /^\*\/(\d{1,2})$/.exec(hour);
    if (stepHour && minute === 0) {
      const n = Number(stepHour[1]);
      if (n >= 1 && n <= 23) return { kind: 'interval', every: 'hour', n };
    }
    // Daily at HH:MM — fixed hour, dow wildcard.
    if (/^\d{1,2}$/.test(hour)) {
      const h = Number(hour);
      if (h <= 23) return { kind: 'daily', at: `${pad(h)}:${pad(minute)}` };
    }
    return null;
  }

  // Weekly on <day> at HH:MM — fixed hour + single dow.
  if (/^\d{1,2}$/.test(hour) && /^[0-6]$/.test(dow)) {
    const h = Number(hour);
    if (h <= 23) return { kind: 'weekly', day: Number(dow), at: `${pad(h)}:${pad(minute)}` };
  }
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Produce a human-readable label for a schedule. Accepts either a
 * `FriendlySchedule` object or a raw cron expression string (which it first
 * tries to recognise via `cronToFriendly`, falling back to a plain passthrough
 * label). Never returns the word "cron" for a recognised friendly schedule.
 */
export function describeSchedule(input: FriendlySchedule | string): string {
  const s: FriendlySchedule =
    typeof input === 'string' ? cronToFriendly(input) ?? { kind: 'cron', expr: input } : input;

  switch (s.kind) {
    case 'manual':
      return 'Manual — runs only when triggered';
    case 'event':
      return `When "${s.topic}" happens`;
    case 'interval': {
      const unit = s.every === 'minute' ? 'minute' : 'hour';
      if (s.n === 1) return `Every ${unit}`;
      return `Every ${s.n} ${unit}s`;
    }
    case 'daily':
      return `Daily at ${formatTime12h(s.at)}`;
    case 'weekly':
      return `Weekly on ${DAY_NAMES[s.day]} at ${formatTime12h(s.at)}`;
    case 'cron':
      // Unrecognised expression — last-resort label. We still avoid leading
      // with "cron"; "Custom schedule" reads better to an operator. The raw
      // expression is appended so a power user can still tell what it is.
      return `Custom schedule (${s.expr})`;
    default: {
      const _exhaustive: never = s;
      throw new Error(`unknown schedule kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Compute the next fire time (UTC) for a cron-backed friendly schedule, given a
 * reference instant. Returns `null` for `manual`/`event` (no cron form) or if
 * the expression can't be parsed. Pure: no timers, no external deps — it walks
 * forward minute-by-minute up to a bounded horizon and tests the cron fields.
 *
 * This is intentionally lightweight (used for a "Next run" preview), not a full
 * cron engine — it only understands the field forms the friendly kinds produce
 * (wildcards, step values, and plain integers), which is all friendlyToCron emits.
 */
export function nextRun(input: FriendlySchedule | string, from: Date = new Date()): Date | null {
  let expr: string;
  if (typeof input === 'string') {
    expr = input;
  } else if (input.kind === 'manual' || input.kind === 'event') {
    return null;
  } else {
    try {
      expr = friendlyToCron(input);
    } catch {
      return null;
    }
  }

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];

  const matches = (field: string, value: number, max: number): boolean => {
    if (field === '*') return true;
    const step = /^\*\/(\d{1,2})$/.exec(field);
    if (step) {
      const n = Number(step[1]);
      return n > 0 && n <= max && value % n === 0;
    }
    if (/^\d{1,2}$/.test(field)) return Number(field) === value;
    return false;
  };

  // Start at the next whole minute after `from`.
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  // Bounded horizon: a weekly schedule fires within 7 days; give a little slack.
  const horizonMinutes = 8 * 24 * 60;
  for (let i = 0; i < horizonMinutes; i++) {
    if (
      matches(minF, cursor.getUTCMinutes(), 59) &&
      matches(hourF, cursor.getUTCHours(), 23) &&
      matches(domF, cursor.getUTCDate(), 31) &&
      matches(monF, cursor.getUTCMonth() + 1, 12) &&
      matches(dowF, cursor.getUTCDay(), 7)
    ) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}
