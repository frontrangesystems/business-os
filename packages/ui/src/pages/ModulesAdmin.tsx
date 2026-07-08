import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Api, ApiError, type ConnectorCapability } from '../lib/api';
import { apiErrorMessage } from '../lib/api-errors';
import { PageHeader } from '../components/PageHeader';
import { capabilityLabel } from '../lib/capability-labels';
import { useToast } from '../lib/toast';

/**
 * Minimal field shapes we render natively (mirrors core's zodToFieldSchema
 * output). We render our own controls here rather than the shared SchemaForm
 * component to keep this page self-contained.
 */
interface FieldMeta {
  type: string;
  values?: string[];
  default?: unknown;
  description?: string;
  optional?: boolean;
}
interface ObjectSchema {
  type: 'object';
  fields: Record<string, FieldMeta>;
}

function humanLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ModuleRow {
  slug: string;
  version: string;
  displayName: string;
  description: string;
  settings: unknown;
  settingsSchema: unknown;
  requiredConnectors: string[];
  connectorBindings: Record<string, string>;
}

/**
 * Operator page for configuring installed MODULES — their settings form and,
 * for modules that declare `requiredConnectors`, an instance-picker dropdown
 * to bind each capability to a specific connector instance (module-bindings).
 * The module then resolves the bound instance via ctx.connector /
 * ctx.connectorCredentials. Mirrors the agent Settings + Connectors sections.
 */
export function ModulesAdmin(): JSX.Element {
  const { toast } = useToast();
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [capabilities, setCapabilities] = useState<ConnectorCapability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<Record<string, unknown>>({});
  const [draftBindings, setDraftBindings] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    try {
      const [m, c] = await Promise.all([Api.listModules(), Api.listConnectors()]);
      setModules(m.modules);
      setCapabilities(c.capabilities);
      setDraftSettings(Object.fromEntries(m.modules.map((mod) => [mod.slug, mod.settings ?? {}])));
      setDraftBindings(
        Object.fromEntries(m.modules.map((mod) => [mod.slug, mod.connectorBindings ?? {}])),
      );
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : 'load failed');
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSettings = async (slug: string): Promise<void> => {
    setBusy(`settings:${slug}`);
    try {
      await Api.updateModuleSettings(slug, draftSettings[slug] ?? {});
      toast.success('Module settings saved.');
      await reload();
    } catch (e: unknown) {
      toast.error(apiErrorMessage(e, 'Save failed.'));
    } finally {
      setBusy(null);
    }
  };

  const saveBindings = async (slug: string): Promise<void> => {
    setBusy(`bindings:${slug}`);
    try {
      const clean = Object.fromEntries(
        Object.entries(draftBindings[slug] ?? {}).filter(([, v]) => v && v.length > 0),
      );
      await Api.updateModuleBindings(slug, clean);
      toast.success('Connections saved.');
      await reload();
    } catch (e: unknown) {
      toast.error(apiErrorMessage(e, 'Save failed.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Modules"
        description="Configure installed modules and pick which connector instance each one uses."
      />
      <div className="space-y-6 p-8">
        {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        {modules.length === 0 && !error && (
          <div className="text-sm text-ink-500 dark:text-ink-400">No modules installed.</div>
        )}
        {modules.map((mod) => (
          <section key={mod.slug} className="card p-6">
            <div className="mb-1 flex items-baseline justify-between">
              <h2 className="section-heading">{mod.displayName}</h2>
              <span className="font-mono text-xs text-ink-500 dark:text-ink-400">
                {mod.slug} · v{mod.version}
              </span>
            </div>
            <p className="mb-5 text-sm text-ink-500 dark:text-ink-400">{mod.description}</p>

            {/* Connections — instance-picker per required capability. */}
            {mod.requiredConnectors.length > 0 && (
              <div className="mb-6">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-ink-700 dark:text-ink-200">
                    Connections
                  </h3>
                  <Link
                    to="/connectors"
                    className="text-xs font-medium text-accent transition-colors hover:text-accent-hover hover:underline"
                  >
                    Manage connector instances →
                  </Link>
                </div>
                <p className="mb-3 text-sm text-ink-500 dark:text-ink-400">
                  Pick which connector instance this module uses for each capability.
                </p>
                <div className="space-y-3">
                  {mod.requiredConnectors.map((cap) => {
                    const capDef = capabilities.find((c) => c.capability === cap);
                    const options = capDef?.instances.filter((i) => i.isActive) ?? [];
                    const value = draftBindings[mod.slug]?.[cap] ?? '';
                    return (
                      <div
                        key={cap}
                        className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[180px_1fr]"
                      >
                        <span className="text-sm text-ink-700 dark:text-ink-300">
                          {capabilityLabel(cap)}
                          <span className="ml-1.5 font-mono text-xs text-ink-500 dark:text-ink-400">
                            {cap}
                          </span>
                        </span>
                        {options.length === 0 ? (
                          <div className="text-xs text-ink-500 dark:text-ink-400">
                            No connected instances yet —{' '}
                            <Link to="/connectors" className="text-accent underline">
                              add one
                            </Link>
                            .
                          </div>
                        ) : (
                          <select
                            className="input"
                            value={value}
                            onChange={(e) =>
                              setDraftBindings((prev) => ({
                                ...prev,
                                [mod.slug]: { ...prev[mod.slug], [cap]: e.target.value },
                              }))
                            }
                          >
                            <option value="">— pick one —</option>
                            {options.map((inst) => (
                              <option key={inst.id} value={inst.id}>
                                {inst.displayName}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <button
                    className="btn-primary"
                    onClick={() => void saveBindings(mod.slug)}
                    disabled={busy === `bindings:${mod.slug}`}
                  >
                    {busy === `bindings:${mod.slug}` ? 'Saving…' : 'Save connections'}
                  </button>
                </div>
              </div>
            )}

            {/* Settings form (auto-rendered from the module's schema). */}
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink-700 dark:text-ink-200">Settings</h3>
              {(() => {
                const schema = mod.settingsSchema as ObjectSchema | null;
                const fields =
                  schema && schema.type === 'object' && schema.fields ? schema.fields : {};
                const current = (draftSettings[mod.slug] ?? {}) as Record<string, unknown>;
                const setField = (key: string, val: unknown): void =>
                  setDraftSettings((prev) => ({
                    ...prev,
                    [mod.slug]: { ...(prev[mod.slug] as Record<string, unknown>), [key]: val },
                  }));
                const keys = Object.keys(fields);
                if (keys.length === 0) {
                  return (
                    <p className="text-sm text-ink-500 dark:text-ink-400">
                      This module has no settings.
                    </p>
                  );
                }
                return (
                  <div className="space-y-4">
                    {keys.map((key) => {
                      const f = fields[key]!;
                      const val = current[key] ?? f.default ?? '';
                      return (
                        <div key={key} className="grid grid-cols-1 gap-1 sm:grid-cols-[180px_1fr]">
                          <label className="text-sm text-ink-700 dark:text-ink-300">
                            {humanLabel(key)}
                          </label>
                          <div>
                            {f.type === 'enum' && f.values ? (
                              <select
                                className="input"
                                value={String(val)}
                                onChange={(e) => setField(key, e.target.value)}
                              >
                                {f.values.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                            ) : f.type === 'boolean' ? (
                              <input
                                type="checkbox"
                                checked={Boolean(val)}
                                onChange={(e) => setField(key, e.target.checked)}
                              />
                            ) : f.type === 'number' ? (
                              <input
                                className="input"
                                type="number"
                                value={val === '' ? '' : Number(val)}
                                onChange={(e) =>
                                  setField(key, e.target.value === '' ? undefined : Number(e.target.value))
                                }
                              />
                            ) : (
                              <input
                                className="input"
                                type="text"
                                value={String(val)}
                                onChange={(e) => setField(key, e.target.value)}
                              />
                            )}
                            {f.description && (
                              <p className="mt-1 text-xs text-ink-500 dark:text-ink-400">
                                {f.description}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              <div className="mt-3">
                <button
                  className="btn-primary"
                  onClick={() => void saveSettings(mod.slug)}
                  disabled={busy === `settings:${mod.slug}`}
                >
                  {busy === `settings:${mod.slug}` ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
