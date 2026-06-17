import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  describeSchedule,
  nextRun,
  DAY_NAMES,
  formatTime12h,
  type FriendlySchedule,
} from '@frontrangesystems/business-os-agent-sdk';
import { Api, ApiError, type FriendlySchedule as ApiFriendlySchedule } from '../lib/api';
import { apiErrorMessage } from '../lib/api-errors';
import { useToast } from '../lib/toast';

/**
 * Renders an agent's effective schedule as a human-readable label plus an Edit
 * button that opens a dialog with friendly controls — no cron jargon, no raw
 * expressions. The operator picks among:
 *   - Manual (runs only when triggered)
 *   - Every N minutes / Every N hours
 *   - Daily at <time>
 *   - Weekly on <day> at <time>
 *   - Event (when the agent + a bound connector support it)
 * A "Next run" preview is computed client-side from the chosen schedule.
 *
 * The friendly schedule is translated to/from cron on the server; the operator
 * never sees a cron expression here.
 */

type Sched = FriendlySchedule;

interface ScheduleData {
  manifest: Sched;
  override: Sched | null;
  effective: Sched;
  description: string;
  nextRunAt: string | null;
  supportedTriggers: Array<'cron' | 'manual' | 'event'>;
  availableEventTopics: Array<{ topic: string; displayName: string; via: string }>;
}

/** Time-based modes the friendly editor offers (maps to the 'cron' trigger). */
type TimedMode = 'interval-minute' | 'interval-hour' | 'daily' | 'weekly';
type EditMode = 'manual' | 'event' | TimedMode;

function modeOf(s: Sched): EditMode {
  switch (s.kind) {
    case 'manual':
      return 'manual';
    case 'event':
      return 'event';
    case 'interval':
      return s.every === 'minute' ? 'interval-minute' : 'interval-hour';
    case 'daily':
      return 'daily';
    case 'weekly':
      return 'weekly';
    case 'cron':
      // Unrecognised cron escape hatch — default the editor to a sensible timed
      // option so the operator can re-author in friendly terms.
      return 'interval-hour';
  }
}

/** Format an ISO timestamp as a friendly "Next run" string with relative hint. */
function formatNextRun(iso: string | null): string {
  if (!iso) return 'Not scheduled';
  const when = new Date(iso);
  const ms = when.getTime() - Date.now();
  const abs = when.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  if (ms <= 0) return abs;
  const mins = Math.round(ms / 60000);
  let rel: string;
  if (mins < 1) rel = 'in under a minute';
  else if (mins < 60) rel = `in ${mins} min`;
  else if (mins < 60 * 24) rel = `in ${Math.round(mins / 60)} hr`;
  else rel = `in ${Math.round(mins / (60 * 24))} d`;
  return `${abs} (${rel})`;
}

export function ScheduleSection({ slug }: { slug: string }): JSX.Element {
  const { toast } = useToast();
  const [data, setData] = useState<ScheduleData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const reload = (): void => {
    Api.getAgentSchedule(slug)
      .then((d) => setData(d as ScheduleData))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'load failed'));
  };

  useEffect(() => {
    reload();
  }, [slug]);

  if (error) {
    return (
      <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
        Schedule: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card p-4 text-sm text-ink-500 dark:text-ink-400">Loading schedule…</div>
    );
  }

  const effLabel = data.description || describeSchedule(data.effective);
  const overrideActive = !!data.override;
  const nextLabel = formatNextRun(data.nextRunAt);
  const showsNext = data.effective.kind !== 'manual' && data.effective.kind !== 'event';

  return (
    <section className="card flex flex-col items-start gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
          Schedule
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="pill-muted">{effLabel}</span>
          {overrideActive ? (
            <span className="text-xs text-ink-500 dark:text-ink-400">
              custom · default is {describeSchedule(data.manifest)}
            </span>
          ) : (
            <span className="text-xs text-ink-500 dark:text-ink-400">default</span>
          )}
        </div>
        {showsNext && (
          <div className="mt-2 text-xs text-ink-500 dark:text-ink-400">
            Next run: <span className="text-ink-700 dark:text-ink-200">{nextLabel}</span>
          </div>
        )}
      </div>
      <button className="btn-secondary shrink-0" onClick={() => setEditing(true)}>
        Edit
      </button>
      <EditDialog
        open={editing}
        onOpenChange={setEditing}
        data={data}
        slug={slug}
        onSaved={(next) => {
          // Server is the source of truth for description + nextRunAt; refetch
          // so the displayed label + preview stay exact after a save.
          void next;
          reload();
          toast.success('Schedule saved.');
          setEditing(false);
        }}
      />
    </section>
  );
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h);
const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function EditDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: ScheduleData;
  slug: string;
  onSaved: (next: Sched | null) => void;
}): JSX.Element {
  const { toast } = useToast();
  const start = props.data.override ?? props.data.manifest;

  const [mode, setMode] = useState<EditMode>(modeOf(start));
  const [intervalN, setIntervalN] = useState<number>(
    start.kind === 'interval' ? start.n : 15,
  );
  // at = "HH:MM" 24h. Split into hour/minute selects for friendliness.
  const [hour, setHour] = useState<number>(() => parseAtHour(start));
  const [minute, setMinute] = useState<number>(() => parseAtMinute(start));
  const [weekday, setWeekday] = useState<number>(start.kind === 'weekly' ? start.day : 1);
  const [eventTopic, setEventTopic] = useState<string>(
    start.kind === 'event' ? start.topic : '',
  );
  const [busy, setBusy] = useState(false);

  // Reset all state when the dialog reopens against fresh data.
  useEffect(() => {
    if (!props.open) return;
    const s = props.data.override ?? props.data.manifest;
    setMode(modeOf(s));
    setIntervalN(s.kind === 'interval' ? s.n : 15);
    setHour(parseAtHour(s));
    setMinute(parseAtMinute(s));
    setWeekday(s.kind === 'weekly' ? s.day : 1);
    setEventTopic(s.kind === 'event' ? s.topic : '');
    setBusy(false);
  }, [props.open, props.data]);

  const supported = new Set(props.data.supportedTriggers);
  const at = `${pad(hour)}:${pad(minute)}`;

  // Build the FriendlySchedule the current form represents.
  const candidate: Sched | null = useMemo(() => {
    switch (mode) {
      case 'manual':
        return { kind: 'manual' };
      case 'event':
        return eventTopic ? { kind: 'event', topic: eventTopic } : null;
      case 'interval-minute':
        return { kind: 'interval', every: 'minute', n: intervalN };
      case 'interval-hour':
        return { kind: 'interval', every: 'hour', n: intervalN };
      case 'daily':
        return { kind: 'daily', at };
      case 'weekly':
        return { kind: 'weekly', day: weekday, at };
    }
  }, [mode, eventTopic, intervalN, at, weekday]);

  const previewNext =
    candidate && candidate.kind !== 'manual' && candidate.kind !== 'event'
      ? nextRun(candidate)
      : null;

  const save = async (): Promise<void> => {
    if (!candidate) return;
    setBusy(true);
    try {
      await Api.setAgentSchedule(props.slug, candidate as ApiFriendlySchedule);
      props.onSaved(candidate);
    } catch (e: unknown) {
      toast.error(apiErrorMessage(e, 'Save failed.'));
    } finally {
      setBusy(false);
    }
  };

  const revert = async (): Promise<void> => {
    setBusy(true);
    try {
      await Api.setAgentSchedule(props.slug, null);
      props.onSaved(null);
    } catch (e: unknown) {
      toast.error(apiErrorMessage(e, 'Revert failed.'));
    } finally {
      setBusy(false);
    }
  };

  // Which modes are offered. Time-based + manual are gated by supportedTriggers;
  // event only when supported AND at least one connector exposes a topic.
  const timedAllowed = supported.has('cron');
  const eventAllowed = supported.has('event');

  const modeOptions: Array<{ value: EditMode; label: string; disabled: boolean }> = [
    { value: 'manual', label: 'Manual', disabled: !supported.has('manual') },
    { value: 'interval-minute', label: 'Every N minutes', disabled: !timedAllowed },
    { value: 'interval-hour', label: 'Every N hours', disabled: !timedAllowed },
    { value: 'daily', label: 'Daily', disabled: !timedAllowed },
    { value: 'weekly', label: 'Weekly', disabled: !timedAllowed },
    { value: 'event', label: 'On an event', disabled: !eventAllowed },
  ];

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl dark:bg-ink-900">
          <Dialog.Title className="text-lg font-semibold tracking-tight">When should this run?</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-ink-500 dark:text-ink-400">
            Choose how often this agent runs. You can change it any time.
          </Dialog.Description>

          <div className="mt-5 space-y-5">
            <fieldset>
              <legend className="label">How it runs</legend>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {modeOptions.map((opt) => {
                  const selected = opt.value === mode;
                  return (
                    <label
                      key={opt.value}
                      className={
                        'rounded-md border px-3 py-1.5 text-sm transition-colors ' +
                        (opt.disabled
                          ? 'opacity-40 cursor-not-allowed '
                          : 'cursor-pointer ') +
                        (selected
                          ? 'border-accent bg-accent/10 text-accent dark:border-accent dark:bg-accent/20'
                          : 'border-ink-200 hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800')
                      }
                    >
                      <input
                        type="radio"
                        className="sr-only"
                        name="schedule-mode"
                        value={opt.value}
                        checked={selected}
                        disabled={opt.disabled}
                        onChange={() => setMode(opt.value)}
                      />
                      {opt.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {mode === 'manual' && (
              <p className="text-sm text-ink-500 dark:text-ink-400">
                This agent runs only when you click <strong>Run now</strong> (or another agent
                triggers it). It won't run on a schedule.
              </p>
            )}

            {(mode === 'interval-minute' || mode === 'interval-hour') && (
              <div>
                <label className="label">Run every</label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    className="input w-24"
                    min={1}
                    max={mode === 'interval-minute' ? 59 : 23}
                    value={intervalN}
                    onChange={(e) => setIntervalN(clamp(Number(e.target.value), 1, mode === 'interval-minute' ? 59 : 23))}
                  />
                  <span className="text-sm text-ink-600 dark:text-ink-300">
                    {mode === 'interval-minute' ? 'minutes' : 'hours'}
                  </span>
                </div>
              </div>
            )}

            {(mode === 'daily' || mode === 'weekly') && (
              <div className="space-y-3">
                {mode === 'weekly' && (
                  <div>
                    <label className="label">On</label>
                    <select
                      className="input mt-1"
                      value={weekday}
                      onChange={(e) => setWeekday(Number(e.target.value))}
                    >
                      {DAY_NAMES.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="label">At (UTC)</label>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      className="input w-24"
                      value={hour}
                      onChange={(e) => setHour(Number(e.target.value))}
                    >
                      {HOUR_OPTIONS.map((h) => (
                        <option key={h} value={h}>
                          {pad(h)}
                        </option>
                      ))}
                    </select>
                    <span className="text-ink-500">:</span>
                    <select
                      className="input w-24"
                      value={minute}
                      onChange={(e) => setMinute(Number(e.target.value))}
                    >
                      {MINUTE_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {pad(m)}
                        </option>
                      ))}
                    </select>
                    <span className="text-sm text-ink-500 dark:text-ink-400">{formatTime12h(at)}</span>
                  </div>
                </div>
              </div>
            )}

            {mode === 'event' && (
              <div>
                <label className="label">Trigger on</label>
                {props.data.availableEventTopics.length > 0 ? (
                  <select
                    className="input mt-1"
                    value={eventTopic}
                    onChange={(e) => setEventTopic(e.target.value)}
                  >
                    <option value="">— pick one —</option>
                    {props.data.availableEventTopics.map((t) => (
                      <option key={`${t.via}::${t.topic}`} value={t.topic}>
                        {t.displayName} (via {t.via})
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-1 rounded border border-dashed border-ink-200 px-3 py-3 text-xs text-ink-500 dark:border-ink-700 dark:text-ink-400">
                    No connected account exposes events yet. Connect a Gmail (or other
                    event-capable) account and bind it to this agent first.
                  </div>
                )}
              </div>
            )}

            {/* Live preview of the resulting schedule + its next run. */}
            {candidate && (
              <div className="rounded-md bg-ink-50 px-3 py-2.5 text-sm dark:bg-ink-800/60">
                <div className="text-ink-700 dark:text-ink-200">{describeSchedule(candidate)}</div>
                {previewNext && (
                  <div className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
                    Next run: {formatNextRun(previewNext.toISOString())}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center justify-end gap-2">
            {props.data.override && (
              <button
                className="btn-ghost"
                onClick={revert}
                disabled={busy}
                title="Go back to the agent's default schedule"
              >
                Reset to default
              </button>
            )}
            <div className="flex-1" />
            <Dialog.Close asChild>
              <button className="btn-ghost" disabled={busy}>
                Cancel
              </button>
            </Dialog.Close>
            <button className="btn-primary" onClick={save} disabled={busy || !candidate}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function parseAtHour(s: Sched): number {
  if ((s.kind === 'daily' || s.kind === 'weekly') && /^\d\d:\d\d$/.test(s.at)) {
    return Number(s.at.slice(0, 2));
  }
  return 9;
}

function parseAtMinute(s: Sched): number {
  if ((s.kind === 'daily' || s.kind === 'weekly') && /^\d\d:\d\d$/.test(s.at)) {
    return Number(s.at.slice(3, 5));
  }
  return 0;
}
