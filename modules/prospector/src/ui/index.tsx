import { useEffect, useState } from 'react';
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

async function postFeedback(
  source: string,
  externalId: string,
  rating: 1 | -1,
): Promise<void> {
  await fetchJson(
    `/api/modules/prospector/bids/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}/feedback`,
    {
      method: 'POST',
      body: JSON.stringify({ rating }),
    },
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

function Thumbs({
  source,
  externalId,
  current,
  onChange,
}: {
  source: string;
  externalId: string;
  current: -1 | 1 | null;
  onChange: (next: -1 | 1) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const click = async (rating: 1 | -1): Promise<void> => {
    setBusy(true);
    try {
      await postFeedback(source, externalId, rating);
      onChange(rating);
    } catch {
      // surfaced by reload; keep UI optimistic
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void click(1)}
        className={`rounded border px-2 py-1 text-sm ${current === 1 ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/40' : 'border-ink-200 dark:border-ink-700'}`}
        aria-label="Worth bidding on"
      >
        👍
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void click(-1)}
        className={`rounded border px-2 py-1 text-sm ${current === -1 ? 'border-red-500 bg-red-50 dark:bg-red-900/40' : 'border-ink-200 dark:border-ink-700'}`}
        aria-label="Not a fit"
      >
        👎
      </button>
    </div>
  );
}

export function ProspectorHomePage(): JSX.Element {
  const [sections, setSections] = useState<HomeSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sort for the "New bids worth a look" section. 'score' = ranked by fit
  // (default); 'due' = latest due date first, so fresh postings surface on top
  // and get caught early.
  const [sort, setSort] = useState<SortKey>('score');

  const reload = async (): Promise<void> => {
    try {
      const r = await fetchJson<{ sections: HomeSection[] }>(
        `/api/modules/prospector/home?sort=${sort}`,
      );
      setSections(r.sections);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    }
  };

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
                      <Thumbs
                        source={card.source}
                        externalId={card.externalId}
                        current={card.myRating}
                        onChange={(rating) => updateRating(card.id, rating)}
                      />
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

  useEffect(() => {
    let cancelled = false;
    setBids(null);
    void (async () => {
      try {
        const r = await fetchJson<{ bids: BidRow[]; minScore: number }>(
          `/api/modules/prospector/bids?limit=100&filter=${filter}${recommendedOnly ? '&recommended=1' : ''}&sort=${sort}`,
        );
        if (!cancelled) {
          setBids(r.bids);
          setMinScore(r.minScore);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'load failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, recommendedOnly, sort]);

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
                  <td className="px-3 py-2">
                    <Thumbs
                      source={b.source}
                      externalId={b.externalId}
                      current={b.myRating}
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
