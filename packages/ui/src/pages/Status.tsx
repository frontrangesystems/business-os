import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Api, ApiError, type AgentRun } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { MissingCapabilityBanner } from '../components/MissingCapabilityBanner';
import { capabilityLabel } from '../lib/capability-labels';

interface StatusData {
  agentCount: number;
  recentRuns: Array<AgentRun & { agentSlug: string }>;
  capabilities: Array<{
    capability: string;
    registered: number;
    configured: number;
    activeProvider: string | null;
  }>;
}

/**
 * Status — install ops overview (agents, recent runs, capability coverage).
 * Admin-only; this is the former Dashboard content, moved here so the Dashboard
 * can be the business-facing landing page. Route + nav are RequireAdmin-gated.
 */
export function Status(): JSX.Element {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    Api.getStatus()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'load failed'));
  }, []);

  if (error) {
    return (
      <div className="p-6 sm:p-8">
        <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-6 sm:p-8 text-sm text-ink-500 dark:text-ink-400">Loading…</div>
    );
  }

  const ok = data.recentRuns.filter((r) => r.ok === true).length;
  const failed = data.recentRuns.filter((r) => r.ok === false).length;

  return (
    <div>
      <PageHeader title="Status" description="Ops overview across this install." />
      <div className="mx-auto max-w-6xl p-6 sm:p-8">
        <MissingCapabilityBanner />
        <div className="grid gap-6 lg:grid-cols-3">
          <Tile label="Agents" value={data.agentCount.toString()} href="/agents" />
          <Tile
            label="Recent runs"
            value={`${data.recentRuns.length}`}
            sub={`${ok} ok · ${failed} failed`}
          />
          <Tile
            label="Capabilities covered"
            value={`${data.capabilities.filter((c) => c.activeProvider).length} / ${data.capabilities.length}`}
            sub="active providers"
            href="/connectors"
          />

          <section className="card p-6 lg:col-span-2">
            <h2 className="section-heading mb-4">Recent runs</h2>
            {data.recentRuns.length === 0 ? (
              <EmptyBlock>No runs yet. Open an agent and click "Run now".</EmptyBlock>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-ink-500 dark:text-ink-400">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">Started</th>
                    <th className="px-4 py-2.5 text-left font-medium">Agent</th>
                    <th className="px-4 py-2.5 text-left font-medium">Result</th>
                    <th className="px-4 py-2.5 text-left font-medium">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                  {data.recentRuns.map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer transition-colors hover:bg-ink-50 dark:hover:bg-ink-800/50"
                      onClick={() => navigate(`/runs/${r.id}`)}
                    >
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-500 dark:text-ink-400">
                        {new Date(r.startedAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          to={`/agents/${r.agentSlug}`}
                          className="font-mono text-xs text-ink-700 transition-colors hover:text-accent dark:text-ink-300"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.agentSlug}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        {r.ok === true ? (
                          <span className="pill-ok">ok</span>
                        ) : r.ok === false ? (
                          <span className="pill-bad">failed</span>
                        ) : (
                          <span className="pill-warn">running</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-700 dark:text-ink-300">{r.summary ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card p-6">
            <h2 className="section-heading mb-4">Capability coverage</h2>
            <div className="divide-y divide-ink-100 text-sm dark:divide-ink-800">
              {data.capabilities.map((c) => (
                <div
                  key={c.capability}
                  className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm">
                      {capabilityLabel(c.capability)}
                      <span className="ml-1.5 font-mono text-xs text-ink-500 dark:text-ink-400">
                        {c.capability}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
                      {c.registered} provider{c.registered === 1 ? '' : 's'} · {c.configured} instance
                      {c.configured === 1 ? '' : 's'}
                    </div>
                  </div>
                  {c.activeProvider ? (
                    <span className="pill-ok">{c.activeProvider}</span>
                  ) : c.configured > 0 ? (
                    <span className="pill-warn">none active</span>
                  ) : (
                    <span className="pill-muted">not configured</span>
                  )}
                </div>
              ))}
            </div>
            <Link
              to="/connectors"
              className="mt-4 inline-block text-xs font-medium text-accent transition-colors hover:text-accent-hover hover:underline"
            >
              Manage connectors →
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}

function EmptyBlock({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="py-10 text-center text-sm text-ink-500 dark:text-ink-400">
      {children}
    </div>
  );
}

function Tile(props: { label: string; value: string; sub?: string; href?: string }): JSX.Element {
  const inner = (
    <div className="card flex h-full flex-col p-6 transition-shadow hover:shadow">
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500 dark:text-ink-400">
        {props.label}
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-ink-900 dark:text-ink-100">
        {props.value}
      </div>
      {props.sub && (
        <div className="mt-1 text-xs text-ink-500 dark:text-ink-400">{props.sub}</div>
      )}
    </div>
  );
  return props.href ? (
    <Link to={props.href} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}
