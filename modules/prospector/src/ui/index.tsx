import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ModuleUiPage } from '@frontrangesystems/business-os-module-sdk';

/**
 * UI half of @frontrangesystems/business-os-module-prospector.
 *
 * Two pages:
 *   - Home (path: ''): dashboard with "New bids worth a look" cards + thumbs feedback.
 *   - Bids (path: 'bids'): full table including triaged / pursuing / won / lost.
 */

interface HomeCard {
  id: string;
  source: string;
  externalId: string;
  title: string;
  subtitle: string;
  score: number | null;
  scoreReason: string | null;
  href: string | null;
  myRating: -1 | 1 | null;
}

interface HomeSection {
  id: string;
  title: string;
  subtitle?: string;
  cards: HomeCard[];
}

interface BidRow {
  source: string;
  externalId: string;
  title: string | null;
  url: string | null;
  location: string | null;
  estimatedValue: number | null;
  bidsDueAt: string | null;
  score: number | null;
  scoreReason: string | null;
  status: string;
  firstSeenAt: string;
  myRating: -1 | 1 | null;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(text || `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

interface ReasonOptions {
  fit: string[];
  pass: string[];
}

const EMPTY_REASONS: ReasonOptions = { fit: [], pass: [] };

async function postFeedback(
  source: string,
  externalId: string,
  rating: 1 | -1,
  reason?: string | null,
  note?: string | null,
): Promise<void> {
  await fetchJson(
    `/api/modules/prospector/bids/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}/feedback`,
    {
      method: 'POST',
      body: JSON.stringify({
        rating,
        ...(reason ? { reason } : {}),
        ...(note && note.trim() ? { note: note.trim() } : {}),
      }),
    },
  );
}

interface MissedJob {
  id: string;
  url: string;
  title: string | null;
  foundVia: string | null;
  note: string | null;
  status: string;
  createdAt: string;
}

async function fetchMissedJobs(): Promise<MissedJob[]> {
  const r = await fetchJson<{ missedJobs: MissedJob[] }>('/api/modules/prospector/missed-jobs');
  return r.missedJobs;
}

async function postMissedJob(input: {
  url: string;
  title?: string;
  foundVia?: string;
  note?: string;
}): Promise<void> {
  await fetchJson('/api/modules/prospector/missed-jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

async function resolveMissedJob(id: string): Promise<void> {
  await fetchJson(`/api/modules/prospector/missed-jobs/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'resolved' }),
  });
}

// --- Generic per-bid document action ---------------------------------------
// Config comes from the /home and /bids responses (driven by module settings).
// When present, each bid gets a button that POSTs {source, externalId} to the
// trigger endpoint; a batch poll of the status endpoint drives the badge. All
// source-specific behavior lives behind those endpoints in the install's own
// module — this UI just renders whatever state/label the status endpoint returns.
interface DocActionConfig {
  label: string;
  triggerPath: string;
  statusPath: string;
}

type PullState = 'none' | 'working' | 'done' | 'failed';

interface PullStatus {
  state: PullState;
  label: string;
  count?: number;
  href?: string;
}

type BidRef = { source: string; externalId: string };

function bidKey(source: string, externalId: string): string {
  return `${source}::${externalId}`;
}

async function fetchPullStatuses(
  statusPath: string,
  bids: BidRef[],
): Promise<Record<string, PullStatus>> {
  if (bids.length === 0) return {};
  const r = await fetchJson<{ statuses?: Record<string, PullStatus> }>(statusPath, {
    method: 'POST',
    body: JSON.stringify({ bids: bids.map((b) => ({ source: b.source, externalId: b.externalId })) }),
  });
  return r.statuses ?? {};
}

/**
 * Batch-load + poll pull statuses for the visible bids, and expose a `trigger`
 * that kicks a pull off and flips that bid to "working". One batch request per
 * page (not one per bid) keeps the All Bids list cheap; polling only continues
 * while at least one bid is still working.
 */
function usePullStatuses(
  docAction: DocActionConfig | null,
  bids: BidRef[] | null,
): { statuses: Record<string, PullStatus>; trigger: (source: string, externalId: string) => void } {
  const [statuses, setStatuses] = useState<Record<string, PullStatus>>({});
  // Only refire the batch fetch when the actual set of bids changes.
  const keys = bids ? bids.map((b) => bidKey(b.source, b.externalId)).join(',') : '';

  const refresh = useCallback(async (): Promise<void> => {
    if (!docAction || !bids || bids.length === 0) return;
    try {
      const map = await fetchPullStatuses(docAction.statusPath, bids);
      setStatuses((prev) => ({ ...prev, ...map }));
    } catch {
      // non-fatal: badges keep their last known state
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docAction, keys]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep polling while any bid is mid-pull.
  useEffect(() => {
    if (!docAction) return;
    const working = Object.values(statuses).some((s) => s.state === 'working');
    if (!working) return;
    const t = setTimeout(() => void refresh(), 4000);
    return () => clearTimeout(t);
  }, [statuses, docAction, refresh]);

  const trigger = useCallback(
    (source: string, externalId: string): void => {
      if (!docAction) return;
      const k = bidKey(source, externalId);
      setStatuses((prev) => ({ ...prev, [k]: { state: 'working', label: 'Starting…' } }));
      void (async () => {
        try {
          await fetchJson(docAction.triggerPath, {
            method: 'POST',
            body: JSON.stringify({ source, externalId }),
          });
          void refresh();
        } catch {
          setStatuses((prev) => ({ ...prev, [k]: { state: 'failed', label: 'Failed to start' } }));
        }
      })();
    },
    [docAction, refresh],
  );

  return { statuses, trigger };
}

/**
 * The per-bid action control: a button when there's nothing pulled yet (or a
 * retry after failure), a muted "working" chip while it runs, and a linked
 * success chip once done. Renders nothing unless the install configured the
 * action, so Prospector shows no button it can't drive.
 */
function PullDocsControl({
  source,
  externalId,
  docAction,
  status,
  onTrigger,
}: {
  source: string;
  externalId: string;
  docAction: DocActionConfig | null;
  status: PullStatus | undefined;
  onTrigger: (source: string, externalId: string) => void;
}): JSX.Element | null {
  if (!docAction) return null;
  const state = status?.state ?? 'none';

  if (state === 'working') {
    const workingCls =
      'inline-flex items-center gap-1.5 rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100';
    const workingBody = (
      <>
        <span className="animate-pulse">⏳</span>
        <span className="whitespace-nowrap">{status?.label ?? 'Working…'}</span>
      </>
    );
    // Once a project exists (status carries its href, i.e. indexing has begun),
    // make the badge a link so the operator can jump into the project and watch
    // it build — same affordance as the finished "Indexed" badge.
    return status?.href ? (
      <a href={status.href} className={`${workingCls} hover:underline`} title="Open the project (still indexing)">
        {workingBody}
      </a>
    ) : (
      <span className={workingCls}>{workingBody}</span>
    );
  }

  if (state === 'done') {
    const body = (
      <>
        <span aria-hidden>✓</span>
        <span className="whitespace-nowrap">{status?.label ?? docAction.label}</span>
      </>
    );
    const cls =
      'inline-flex items-center gap-1.5 rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-100';
    return status?.href ? (
      <a href={status.href} className={`${cls} hover:underline`}>
        {body}
      </a>
    ) : (
      <span className={cls}>{body}</span>
    );
  }

  // 'none' | 'failed' → an actionable button.
  const failed = state === 'failed';
  return (
    <button
      type="button"
      onClick={() => onTrigger(source, externalId)}
      title={failed ? 'Retry the document pull' : `${docAction.label} for this bid`}
      className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs transition ${
        failed
          ? 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30'
          : 'border-ink-200 text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-800'
      }`}
    >
      <span aria-hidden>{failed ? '↻' : '⬇'}</span>
      <span className="whitespace-nowrap">{failed ? status?.label ?? 'Retry' : docAction.label}</span>
    </button>
  );
}

function ScoreBadge({ value }: { value: number | null }): JSX.Element | null {
  if (value === null) return null;
  const tone =
    value >= 80
      ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100'
      : value >= 60
        ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100'
        : 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300';
  return (
    <span className={`inline-flex h-7 min-w-[2.5rem] items-center justify-center rounded px-2 text-sm font-semibold ${tone}`}>
      {value}%
    </span>
  );
}

/**
 * Feedback control. Two labeled buttons — "More like this" (👍) / "Fewer like
 * this" (👎) — so the action is self-explanatory. Clicking one records the
 * rating immediately (stays fast), then reveals a reason panel: quick-pick tags
 * (from the operator's configurable menu) + an optional note. The reason is what
 * turns a thumb into real training signal for the scorer.
 */
function Thumbs({
  source,
  externalId,
  current,
  reasons,
  onChange,
}: {
  source: string;
  externalId: string;
  current: -1 | 1 | null;
  reasons: ReasonOptions;
  onChange: (next: -1 | 1) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState<-1 | 1 | null>(current);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const save = async (r: 1 | -1, reasonVal: string | null, noteVal: string): Promise<void> => {
    setBusy(true);
    try {
      await postFeedback(source, externalId, r, reasonVal, noteVal);
    } catch {
      // surfaced by reload; keep UI optimistic
    } finally {
      setBusy(false);
    }
  };

  const clickThumb = (r: 1 | -1): void => {
    if (r === rating) {
      // Same direction — just toggle the reason panel. Don't re-save (that would
      // wipe a reason already stored for this bid).
      setOpen((o) => !o);
      return;
    }
    // New / changed direction: record instantly with a cleared reason (a 👎's
    // pass-reason doesn't carry over to a 👍), then open the panel to capture why.
    setRating(r);
    setReason(null);
    setNote('');
    setOpen(true);
    onChange(r);
    void save(r, null, '');
  };

  const pickReason = (tag: string): void => {
    if (!rating) return;
    const next = reason === tag ? null : tag; // click again to clear
    setReason(next);
    void save(rating, next, note);
  };

  const tags = rating === 1 ? reasons.fit : rating === -1 ? reasons.pass : [];

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => clickThumb(1)}
          title="Surface more bids like this"
          aria-pressed={rating === 1}
          className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-sm ${rating === 1 ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/40' : 'border-ink-200 hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800'}`}
        >
          👍 <span className="whitespace-nowrap">More like this</span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => clickThumb(-1)}
          title="Surface fewer bids like this"
          aria-pressed={rating === -1}
          className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-sm ${rating === -1 ? 'border-red-500 bg-red-50 dark:bg-red-900/40' : 'border-ink-200 hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800'}`}
        >
          👎 <span className="whitespace-nowrap">Fewer like this</span>
        </button>
      </div>

      {open && rating !== null && (
        <div className="w-full max-w-xs rounded-md border border-ink-200 bg-ink-50/60 p-2.5 text-left dark:border-ink-700 dark:bg-ink-800/40">
          <div className="mb-1.5 text-xs font-medium text-ink-600 dark:text-ink-300">
            {rating === 1 ? "Why is it a fit?" : 'Why pass?'}{' '}
            <span className="font-normal text-ink-400">(optional — helps the AI learn)</span>
          </div>
          {tags.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => pickReason(t)}
                  className={`rounded-full border px-2 py-0.5 text-xs transition ${
                    reason === t
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-ink-200 text-ink-600 hover:bg-ink-100 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-700'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => rating !== null && void save(rating, reason, note)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            placeholder="Add a note (optional)"
            className="w-full rounded border border-ink-200 bg-white px-2 py-1 text-xs dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100"
          />
        </div>
      )}
    </div>
  );
}

/**
 * "Report a job we missed" panel. Trevor finds jobs by hand that the crawler
 * never surfaced; this is where he flags them ("this should have been
 * included"). A collapsed button keeps Home uncluttered; open reports show as a
 * short list with a "Mark handled" action so the queue can be cleared. The
 * reports are coverage-gap signal for tuning which boards/agencies we crawl.
 */
function MissedJobsPanel(): JSX.Element {
  const [jobs, setJobs] = useState<MissedJob[] | null>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [foundVia, setFoundVia] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const reload = async (): Promise<void> => {
    try {
      setJobs(await fetchMissedJobs());
    } catch {
      // non-fatal: the panel just shows no list
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!url.trim()) {
      setError('Paste the link to the job.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postMissedJob({
        url: url.trim(),
        title: title.trim() || undefined,
        foundVia: foundVia.trim() || undefined,
        note: note.trim() || undefined,
      });
      setUrl('');
      setTitle('');
      setFoundVia('');
      setNote('');
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 3000);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save — check the link is a full URL.');
    } finally {
      setBusy(false);
    }
  };

  const markHandled = async (id: string): Promise<void> => {
    setJobs((prev) => (prev ? prev.filter((j) => j.id !== id) : prev));
    try {
      await resolveMissedJob(id);
    } catch {
      void reload(); // put it back if the call failed
    }
  };

  const openCount = jobs?.length ?? 0;

  return (
    <section className="card mb-8 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Missed a job?</h2>
          <p className="text-xs text-ink-500">
            Found a bid the Prospector didn't surface? Flag it — it helps us fix what we're not
            crawling.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded-full border border-ink-200 px-3 py-1 text-sm text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-800"
        >
          {open ? 'Close' : '＋ Report a missed job'}
        </button>
      </div>

      {open && (
        <form onSubmit={submit} className="mt-4 grid gap-2 sm:max-w-xl">
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Link to the job posting (required)"
            className="w-full rounded border border-ink-200 bg-white px-2.5 py-1.5 text-sm dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100"
          />
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What is it? (optional)"
            className="w-full rounded border border-ink-200 bg-white px-2.5 py-1.5 text-sm dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100"
          />
          <input
            type="text"
            value={foundVia}
            onChange={(e) => setFoundVia(e.target.value)}
            placeholder="Where did you find it? e.g. Central Auction (optional)"
            className="w-full rounded border border-ink-200 bg-white px-2.5 py-1.5 text-sm dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100"
          />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything else — why it should've been included (optional)"
            rows={2}
            className="w-full rounded border border-ink-200 bg-white px-2.5 py-1.5 text-sm dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100"
          />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Flag this job'}
            </button>
            {justSaved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Flagged — thanks.</span>}
          </div>
        </form>
      )}

      {openCount > 0 && (
        <div className="mt-4 border-t border-ink-100 pt-3 dark:border-ink-800">
          <div className="mb-2 text-xs font-medium text-ink-600 dark:text-ink-300">
            Flagged as missed ({openCount})
          </div>
          <ul className="space-y-2">
            {jobs!.map((j) => (
              <li key={j.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <a
                    href={j.url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-words font-medium text-accent hover:underline"
                  >
                    {j.title || j.url}
                  </a>
                  <div className="text-xs text-ink-500">
                    {[j.foundVia ? `via ${j.foundVia}` : null, j.note]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => markHandled(j.id)}
                  className="shrink-0 rounded border border-ink-200 px-2 py-0.5 text-xs text-ink-600 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-800"
                >
                  Mark handled
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function ProspectorHomePage(): JSX.Element {
  const [sections, setSections] = useState<HomeSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sort for the "New bids worth a look" section. 'score' = ranked by fit
  // (default); 'due' = latest due date first, so fresh postings surface on top
  // and get caught early.
  const [sort, setSort] = useState<SortKey>('score');
  const [reasons, setReasons] = useState<ReasonOptions>(EMPTY_REASONS);
  const [docAction, setDocAction] = useState<DocActionConfig | null>(null);

  const reload = async (): Promise<void> => {
    try {
      const r = await fetchJson<{
        sections: HomeSection[];
        reasonOptions?: ReasonOptions;
        docAction?: DocActionConfig | null;
      }>(`/api/modules/prospector/home?sort=${sort}`);
      setSections(r.sections);
      if (r.reasonOptions) setReasons(r.reasonOptions);
      setDocAction(r.docAction ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    }
  };

  const allCards: BidRef[] = sections
    ? sections.flatMap((s) => s.cards.map((c) => ({ source: c.source, externalId: c.externalId })))
    : [];
  const { statuses: pullStatuses, trigger: pullTrigger } = usePullStatuses(
    docAction,
    sections ? allCards : null,
  );

  useEffect(() => {
    setSections(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);

  const updateRating = (cardId: string, rating: 1 | -1): void => {
    if (!sections) return;
    setSections(
      sections.map((s) => ({
        ...s,
        cards: s.cards.map((c) => (c.id === cardId ? { ...c, myRating: rating } : c)),
      })),
    );
  };

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Home</h1>
        <p className="text-sm text-ink-500">
          Today's actionable items, ranked by fit.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/30 dark:text-red-200">
          {error}
        </div>
      )}

      <MissedJobsPanel />

      {!sections ? (
        <div className="text-ink-500">Loading…</div>
      ) : (
        sections.map((section) => (
          <section key={section.id} className="mb-8">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
              <h2 className="text-base font-semibold">{section.title}</h2>
              {section.subtitle && (
                <p className="text-xs text-ink-500">{section.subtitle}</p>
              )}
              {section.id === 'new-bids' && (
                <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-600 dark:text-ink-400">
                  Sort
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    className="rounded-full border border-ink-200 bg-white px-2.5 py-1 text-xs text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300 dark:hover:bg-ink-800"
                  >
                    {SORT_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {section.cards.length === 0 ? (
              <p className="text-sm text-ink-500">Nothing new.</p>
            ) : (
              <div className="space-y-3">
                {section.cards.map((card) => (
                  <article key={card.id} className="card p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-3">
                          <ScoreBadge value={card.score} />
                          {card.href ? (
                            <a
                              href={card.href}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium text-accent hover:underline"
                            >
                              {card.title}
                            </a>
                          ) : (
                            <span className="font-medium">{card.title}</span>
                          )}
                        </div>
                        {card.subtitle && (
                          <div className="ml-[3.25rem] mt-1 text-sm text-ink-600 dark:text-ink-400">
                            {card.subtitle}
                          </div>
                        )}
                        {card.scoreReason && (
                          <div className="ml-[3.25rem] mt-2 text-sm text-ink-700 dark:text-ink-300">
                            {card.scoreReason}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <Thumbs
                          source={card.source}
                          externalId={card.externalId}
                          current={card.myRating}
                          reasons={reasons}
                          onChange={(rating) => updateRating(card.id, rating)}
                        />
                        <PullDocsControl
                          source={card.source}
                          externalId={card.externalId}
                          docAction={docAction}
                          status={pullStatuses[bidKey(card.source, card.externalId)]}
                          onTrigger={pullTrigger}
                        />
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}

type BidFilter = 'all' | 'worth-bidding' | 'not-a-fit' | 'not-reviewed';

const FILTER_OPTIONS: Array<{ id: BidFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'worth-bidding', label: '👍 Worth bidding' },
  { id: 'not-a-fit', label: '👎 Not a fit' },
  { id: 'not-reviewed', label: 'Not reviewed' },
];

type SortKey = 'score' | 'due';

const SORT_OPTIONS: Array<{ id: SortKey; label: string }> = [
  { id: 'score', label: 'Ranking' },
  { id: 'due', label: 'Due date (newest first)' },
];

export function ProspectorBidsPage(): JSX.Element {
  const [bids, setBids] = useState<BidRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<BidFilter>('all');
  // Default to the recommended set so the operator lands on bids worth rating,
  // one toggle away from the full list.
  const [recommendedOnly, setRecommendedOnly] = useState(true);
  // Sort order. 'score' = highest ranking first (default). 'due' = latest due
  // date first, so newly-posted bids (longest lead time) sit on top and get
  // caught early.
  const [sort, setSort] = useState<SortKey>('score');
  const [minScore, setMinScore] = useState<number | null>(null);
  const [reasons, setReasons] = useState<ReasonOptions>(EMPTY_REASONS);
  const [docAction, setDocAction] = useState<DocActionConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBids(null);
    void (async () => {
      try {
        const r = await fetchJson<{
          bids: BidRow[];
          minScore: number;
          reasonOptions?: ReasonOptions;
          docAction?: DocActionConfig | null;
        }>(
          `/api/modules/prospector/bids?limit=100&filter=${filter}${recommendedOnly ? '&recommended=1' : ''}&sort=${sort}`,
        );
        if (!cancelled) {
          setBids(r.bids);
          setMinScore(r.minScore);
          if (r.reasonOptions) setReasons(r.reasonOptions);
          setDocAction(r.docAction ?? null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'load failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, recommendedOnly, sort]);

  const { statuses: pullStatuses, trigger: pullTrigger } = usePullStatuses(
    docAction,
    bids ? bids.map((b) => ({ source: b.source, externalId: b.externalId })) : null,
  );

  const updateRating = (source: string, externalId: string, rating: 1 | -1): void => {
    setBids((prev) =>
      prev
        ? prev.map((b) =>
            b.source === source && b.externalId === externalId ? { ...b, myRating: rating } : b,
          )
        : prev,
    );
  };

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">All bids</h1>
        <p className="text-sm text-ink-500">
          {sort === 'due' ? 'Newest due dates first' : 'Ranked by score'}. Showing{' '}
          {recommendedOnly
            ? `recommended bids${minScore !== null ? ` (score ≥ ${minScore})` : ''}`
            : 'every bid the watcher has surfaced'}
          . Thumb each one 👍/👎 — your calls tune future scoring.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => setFilter(opt.id)}
            className={`rounded-full border px-3 py-1 text-sm transition ${
              filter === opt.id
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-ink-200 text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-800'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-ink-200 dark:bg-ink-700" aria-hidden />
        <button
          type="button"
          onClick={() => setRecommendedOnly((v) => !v)}
          aria-pressed={recommendedOnly}
          className={`rounded-full border px-3 py-1 text-sm transition ${
            recommendedOnly
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-ink-200 text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-300 dark:hover:bg-ink-800'
          }`}
        >
          {recommendedOnly ? '★ Recommended only' : 'Showing all — recommended only?'}
        </button>
        <span className="mx-1 h-5 w-px bg-ink-200 dark:bg-ink-700" aria-hidden />
        <label className="flex items-center gap-1.5 text-sm text-ink-600 dark:text-ink-400">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-full border border-ink-200 bg-white px-3 py-1 text-sm text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300 dark:hover:bg-ink-800"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/30 dark:text-red-200">
          {error}
        </div>
      )}

      {!bids ? (
        <div className="text-ink-500">Loading…</div>
      ) : bids.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-500">
          {filter === 'all'
            ? 'No bids yet.'
            : filter === 'worth-bidding'
              ? "You haven't marked any bids as worth bidding."
              : filter === 'not-a-fit'
                ? "You haven't passed on any bids."
                : 'Nothing left to review.'}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500 dark:bg-ink-900">
              <tr>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Status</th>
                {docAction && <th className="px-3 py-2">Docs</th>}
                <th className="px-3 py-2">Rate</th>
              </tr>
            </thead>
            <tbody>
              {bids.map((b) => (
                <tr key={`${b.source}::${b.externalId}`} className="border-t border-ink-100 dark:border-ink-800">
                  <td className="px-3 py-2">
                    <ScoreBadge value={b.score} />
                  </td>
                  <td className="px-3 py-2">
                    {b.url ? (
                      <a href={b.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        {b.title ?? 'Untitled'}
                      </a>
                    ) : (
                      b.title ?? 'Untitled'
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink-600 dark:text-ink-400">{b.location ?? '—'}</td>
                  <td className="px-3 py-2 text-ink-600 dark:text-ink-400">
                    {b.estimatedValue !== null ? `$${b.estimatedValue.toLocaleString()}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-ink-600 dark:text-ink-400">
                    {b.bidsDueAt ? new Date(b.bidsDueAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded bg-ink-100 px-2 py-0.5 text-xs dark:bg-ink-800">{b.status}</span>
                  </td>
                  {docAction && (
                    <td className="px-3 py-2">
                      <PullDocsControl
                        source={b.source}
                        externalId={b.externalId}
                        docAction={docAction}
                        status={pullStatuses[bidKey(b.source, b.externalId)]}
                        onTrigger={pullTrigger}
                      />
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <Thumbs
                      source={b.source}
                      externalId={b.externalId}
                      current={b.myRating}
                      reasons={reasons}
                      onChange={(rating) => updateRating(b.source, b.externalId, rating)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export const uiPages: ModuleUiPage[] = [
  { path: '', navLabel: 'Home', Component: ProspectorHomePage },
  { path: 'bids', navLabel: 'All bids', Component: ProspectorBidsPage },
];
