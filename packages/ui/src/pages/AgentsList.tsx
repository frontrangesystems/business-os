import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { describeSchedule } from '@frontrangesystems/business-os-agent-sdk';
import { Api, ApiError, type AgentSummary } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { SchemaForm, defaultFor, type FieldSchema } from '../components/SchemaForm';
import { AddAgentDialog } from '../components/AddAgentDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../lib/toast';

function ScheduleLabel({ agent }: { agent: AgentSummary }): JSX.Element {
  // Prefer the server-rendered friendly label (reflects operator overrides and
  // never shows a raw cron expression). Fall back to deriving one from the raw
  // manifest schedule for older API responses.
  const label = agent.scheduleDescription ?? describeSchedule(agent.effectiveSchedule ?? agent.schedule);
  const muted = (agent.effectiveSchedule ?? agent.schedule).kind === 'manual';
  return (
    <span className={muted ? 'text-ink-500 dark:text-ink-400' : undefined}>{label}</span>
  );
}

function LastRunCell({ run }: { run: AgentSummary['lastRun'] }): JSX.Element {
  if (!run) return <span className="text-ink-400 dark:text-ink-500">—</span>;
  const className = run.ok === true ? 'pill-ok' : run.ok === false ? 'pill-bad' : 'pill-warn';
  const label = run.ok === true ? 'ok' : run.ok === false ? 'failed' : 'running';
  return (
    <div className="flex items-center gap-2">
      <span className={className}>{label}</span>
      <span className="truncate text-xs text-ink-500 dark:text-ink-400">{run.summary ?? ''}</span>
    </div>
  );
}

export function AgentsList(): JSX.Element {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [inputModalFor, setInputModalFor] = useState<AgentSummary | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const { toast } = useToast();

  const disableAgent = async (slug: string, displayName: string): Promise<void> => {
    try {
      await Api.disableAgent(slug);
      toast.success(`${displayName} disabled.`);
      load();
    } catch (e: unknown) {
      toast.error(e instanceof ApiError ? e.message : 'disable failed');
      throw e;
    }
  };

  const load = (): void => {
    Api.listAgents()
      .then((r) => setAgents(r.agents))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'load failed'));
  };

  useEffect(() => {
    load();
  }, []);

  const fireRun = async (agent: AgentSummary, input: unknown): Promise<void> => {
    setRunning(agent.slug);
    try {
      await Api.runAgent(agent.slug, input);
      toast.success(`${agent.displayName} started`);
      // Server enqueues; reload to pick up the new lastRun once it lands.
      setTimeout(load, 800);
    } catch (e: unknown) {
      const msg = e instanceof ApiError ? e.message : 'run failed';
      toast.error(`${agent.displayName}: ${msg}`);
    } finally {
      setRunning(null);
    }
  };

  const onRunClick = (agent: AgentSummary): void => {
    const schema = agent.inputSchema as FieldSchema | null | undefined;
    const needsInput =
      !!schema &&
      schema.type === 'object' &&
      Object.keys((schema as { fields: object }).fields).length > 0;
    if (needsInput) {
      setInputModalFor(agent);
    } else {
      void fireRun(agent, undefined);
    }
  };

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Everything running on this install. Click an agent to configure or run it."
        right={
          <button className="btn-primary" onClick={() => setAddOpen(true)}>
            Add agent
          </button>
        }
      />
      <div className="p-6 sm:p-8">
        {error && (
          <div className="card mb-4 border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
            {error}
          </div>
        )}
        {!agents ? (
          <div className="text-sm text-ink-500 dark:text-ink-400">Loading…</div>
        ) : agents.length === 0 ? (
          <div className="card p-10 text-center">
            <h3 className="text-base font-semibold tracking-tight">No agents installed yet</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-ink-500 dark:text-ink-400">
              Click <strong>Add agent</strong> to install one. The catalog is everything this install
              knows how to run — pick what you want, configure connectors and defaults, done.
            </p>
            <button className="btn-primary mt-5" onClick={() => setAddOpen(true)}>
              Add agent
            </button>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-[11px] uppercase tracking-wider text-ink-500 dark:bg-ink-800/60 dark:text-ink-400">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Agent</th>
                  <th className="px-4 py-2.5 text-left font-medium">Schedule</th>
                  <th className="px-4 py-2.5 text-left font-medium">Last run</th>
                  <th className="px-4 py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {agents.map((a) => (
                  <tr
                    key={a.slug}
                    className="transition-colors hover:bg-ink-50 dark:hover:bg-ink-800/50"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/agents/${a.slug}`}
                        className="font-medium text-ink-900 transition-colors hover:text-accent dark:text-ink-100"
                      >
                        {a.displayName}
                      </Link>
                      <div className="mt-0.5 font-mono text-xs text-ink-500 dark:text-ink-400">
                        {a.slug} · v{a.version}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-ink-700 dark:text-ink-300">
                      <ScheduleLabel agent={a} />
                    </td>
                    <td className="px-4 py-3">
                      <LastRunCell run={a.lastRun} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          className="btn-secondary"
                          disabled={running === a.slug}
                          onClick={() => onRunClick(a)}
                        >
                          {running === a.slug ? 'Starting…' : 'Run'}
                        </button>
                        <ConfirmDialog
                          title={`Disable ${a.displayName}?`}
                          description="Settings, bindings, and run history stay so you can re-enable later. The agent stops firing on any schedule until then."
                          confirmLabel="Disable"
                          variant="danger"
                          onConfirm={() => disableAgent(a.slug, a.displayName)}
                        >
                          <button
                            className="btn-ghost text-ink-500 hover:text-bad"
                            aria-label={`Disable ${a.displayName}`}
                            title="Disable agent"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M3 6h18" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </ConfirmDialog>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {inputModalFor && (
        <RunWithInputModal
          agent={inputModalFor}
          onCancel={() => setInputModalFor(null)}
          onSubmit={async (input) => {
            const a = inputModalFor;
            setInputModalFor(null);
            await fireRun(a, input);
          }}
        />
      )}
      <AddAgentDialog open={addOpen} onOpenChange={setAddOpen} onEnabled={load} />
    </div>
  );
}

function RunWithInputModal(props: {
  agent: AgentSummary;
  onCancel: () => void;
  onSubmit: (input: unknown) => Promise<void>;
}): JSX.Element {
  const schema = props.agent.inputSchema as FieldSchema;
  const [value, setValue] = useState<unknown>(() => defaultFor(schema));
  const [busy, setBusy] = useState(false);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && props.onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl dark:bg-ink-900">
          <Dialog.Title className="text-lg font-semibold tracking-tight">
            Run {props.agent.displayName}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-ink-500 dark:text-ink-400">
            Provide input for this run. It won't be saved as a default.
          </Dialog.Description>
          <div className="mt-5">
            <SchemaForm schema={schema} value={value} onChange={setValue} />
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button className="btn-ghost" onClick={props.onCancel} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await props.onSubmit(value);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Starting…' : 'Run'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
