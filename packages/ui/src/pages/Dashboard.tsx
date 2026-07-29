import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Api, ApiError, type DashboardCard } from '../lib/api';
import { PageHeader } from '../components/PageHeader';

/**
 * Dashboard — the default landing page for every role. Renders the cards each
 * installed module contributes (see module-sdk's dashboardContribution). Core
 * aggregates them per user at GET /api/dashboard; this page just lays them out.
 * Install ops/status moved to the admin-only Status page.
 */
export function Dashboard(): JSX.Element {
  const [cards, setCards] = useState<DashboardCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Api.getDashboard()
      .then((r) => setCards(r.cards))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'load failed'));
  }, []);

  if (error) {
    return (
      <div className="p-6 sm:p-8">
        <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>
      </div>
    );
  }
  if (!cards) {
    return (
      <div className="p-6 sm:p-8 text-sm text-ink-500 dark:text-ink-400">Loading…</div>
    );
  }

  return (
    <div>
      <PageHeader title="Dashboard" description="Your day at a glance." />
      <div className="mx-auto max-w-6xl p-6 sm:p-8">
        {cards.length === 0 ? (
          <div className="card p-10 text-center">
            <div className="text-sm font-medium text-ink-700 dark:text-ink-200">
              Nothing on your dashboard yet
            </div>
            <div className="mx-auto mt-1.5 max-w-md text-sm text-ink-500 dark:text-ink-400">
              As modules are enabled and start finding work for you, their
              highlights show up here.
            </div>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {cards.map((c) => (
              <CardTile key={c.moduleSlug} card={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CardTile({ card }: { card: DashboardCard }): JSX.Element {
  return (
    <section className="card flex flex-col p-6">
      <div className="mb-4">
        <h2 className="section-heading">{card.title}</h2>
        {card.summary && (
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">{card.summary}</p>
        )}
      </div>

      {card.items.length === 0 ? (
        <div className="py-8 text-center text-sm text-ink-500 dark:text-ink-400">
          {card.emptyText ?? 'Nothing to show right now.'}
        </div>
      ) : (
        <ul className="flex-1 divide-y divide-ink-100 dark:divide-ink-800">
          {card.items.map((item, i) => (
            <li key={i} className="py-2.5 first:pt-0">
              <Row item={item} />
            </li>
          ))}
        </ul>
      )}

      {card.ctaHref && (
        <div className="mt-4">
          <Link
            to={card.ctaHref}
            className="inline-block text-xs font-medium text-accent transition-colors hover:text-accent-hover hover:underline"
          >
            {card.ctaLabel ?? 'View all'} →
          </Link>
        </div>
      )}
    </section>
  );
}

function Row({
  item,
}: {
  item: { title: string; subtitle?: string; href?: string; badge?: string };
}): JSX.Element {
  const body = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-ink-800 dark:text-ink-100">
          {item.title}
        </div>
        {item.subtitle && (
          <div className="mt-0.5 truncate text-xs text-ink-500 dark:text-ink-400">
            {item.subtitle}
          </div>
        )}
      </div>
      {item.badge && <span className="pill-muted shrink-0">{item.badge}</span>}
    </div>
  );

  if (!item.href) return body;

  // Deep links can be in-app (module route) or external (source URL). Keep
  // in-app links as client-side navigations; send absolute URLs out in a new tab.
  const isExternal = /^https?:\/\//.test(item.href);
  return isExternal ? (
    <a
      href={item.href}
      target="_blank"
      rel="noreferrer"
      className="block rounded-md transition-colors hover:bg-ink-50 dark:hover:bg-ink-800/50"
    >
      {body}
    </a>
  ) : (
    <Link
      to={item.href}
      className="block rounded-md transition-colors hover:bg-ink-50 dark:hover:bg-ink-800/50"
    >
      {body}
    </Link>
  );
}
