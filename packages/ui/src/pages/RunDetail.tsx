import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Api, ApiError, type AgentRun, type AuditEntry } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { detailsToCsv, detailsToMarkdown, downloadText } from '../lib/export';
import { RunDetailsRenderer } from '../components/RunDetailsRenderer';
import { MetaCell } from '../components/MetaCell';

interface RunWithDetails extends AgentRun {
  agentSlug: string;
  details: unknown;
}

export function RunDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<RunWithDetails | null>(null);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    Api.getRun(id)
      .then(({ run, audits }) => {
        setRun(run);
        setAudits(audits);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'load failed'));
  }, [id]);

  if (error) {
    return (
      <div className="p-6 sm:p-8">
        <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="p-6 sm:p-8 text-sm text-ink-500 dark:text-ink-400">Loading…</div>
    );
  }

  const durationMs = run.endedAt
    ? new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
    : null;

  return (
    <div>
      <PageHeader
        title={`Run · ${run.agentSlug}`}
        description={
          <span className="font-mono text-xs">
            {run.id}
          </span> as unknown as string
        }
        right={
          <Link to={`/agents/${run.agentSlug}`} className="btn-secondary">
            ← Agent
          </Link>
        }
      />
      {/* Single column: Outcome, then Details (full width — the details/digest
          tables need the room), then the audit trail. */}
      <div className="mx-auto grid max-w-6xl gap-6 p-6 sm:p-8">
        <section className="card p-6">
          <h2 className="section-heading mb-4">Outcome</h2>
          <div className="divide-y divide-ink-100 text-sm dark:divide-ink-800">
            <Row label="Started">{new Date(run.startedAt).toLocaleString()}</Row>
            <Row label="Ended">
              {run.endedAt ? new Date(run.endedAt).toLocaleString() : '—'}
            </Row>
            <Row label="Duration">
              {durationMs == null ? '—' : `${(durationMs / 1000).toFixed(2)}s`}
            </Row>
            <Row label="Trigger">
              <span className="font-mono text-xs">{run.trigger ?? '—'}</span>
            </Row>
            <Row label="Triggered by">
              <span className="font-mono text-xs">{run.triggeredBy ?? 'system'}</span>
            </Row>
            <Row label="Status">
              {run.ok === true ? (
                <span className="pill-ok">ok</span>
              ) : run.ok === false ? (
                <span className="pill-bad">failed</span>
              ) : (
                <span className="pill-warn">running</span>
              )}
            </Row>
            <Row label="Summary">{run.summary ?? '—'}</Row>
          </div>
        </section>

        <section className="card p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="section-heading">Details</h2>
            <ExportButtons run={run} />
          </div>
          <RunDetailsRenderer details={run.details} />
        </section>

        <section className="card p-6 lg:col-span-2">
          <h2 className="section-heading mb-4">Audit trail for this run</h2>
          {audits.length === 0 ? (
            <div className="py-10 text-center text-sm text-ink-500 dark:text-ink-400">
              No audit entries — this run didn't call ctx.audit().
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-ink-500 dark:text-ink-400">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">When</th>
                  <th className="px-4 py-2.5 text-left font-medium">Action</th>
                  <th className="px-4 py-2.5 text-left font-medium">Meta</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {audits.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-2.5 align-top font-mono text-xs text-ink-500 dark:text-ink-400">
                      {new Date(a.at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <span className="font-mono text-xs">{a.action}</span>
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <MetaCell meta={a.meta} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex gap-3 py-2 first:pt-0 last:pb-0">
      <div className="w-32 shrink-0 text-[11px] font-medium uppercase tracking-wider text-ink-500 dark:text-ink-400">
        {label}
      </div>
      <div className="text-ink-800 dark:text-ink-200">{children}</div>
    </div>
  );
}

function ExportButtons({ run }: { run: RunWithDetails }): JSX.Element | null {
  const csv = detailsToCsv(run);
  const md = detailsToMarkdown(run);
  if (!csv && !md) return null;
  const base = `${run.agentSlug}-${run.id.slice(0, 8)}`;
  return (
    <div className="flex gap-2">
      {csv && (
        <button
          className="btn-secondary"
          onClick={() => downloadText(`${base}.csv`, 'text/csv', csv)}
        >
          Download CSV
        </button>
      )}
      {md && (
        <button
          className="btn-secondary"
          onClick={() => downloadText(`${base}.md`, 'text/markdown', md)}
        >
          Download Markdown
        </button>
      )}
    </div>
  );
}
