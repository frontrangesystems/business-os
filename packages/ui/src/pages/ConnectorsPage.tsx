import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Api, ApiError, type ConnectorCapability } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { SchemaForm, defaultFor, type FieldSchema } from '../components/SchemaForm';
import { capabilityLabel } from '../lib/capability-labels';
import { apiErrorMessage } from '../lib/api-errors';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ProvidersTab } from '../components/ProvidersTab';
import { useToast } from '../lib/toast';

export function ConnectorsPage(): JSX.Element {
  const { toast } = useToast();
  const [caps, setCaps] = useState<ConnectorCapability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null); // capability being added to
  // ?tab=available switches to the providers marketplace.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: 'configured' | 'available' =
    searchParams.get('tab') === 'available' ? 'available' : 'configured';

  const reload = async (): Promise<void> => {
    try {
      const r = await Api.listConnectors();
      setCaps(r.capabilities);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : 'load failed');
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const addInstance = async (
    capability: string,
    providerSlug: string,
    displayName: string,
    extras?: { credentials?: Record<string, unknown>; settings?: unknown },
  ): Promise<void> => {
    try {
      await Api.createConnector({
        capability,
        providerSlug,
        displayName,
        ...(extras ?? {}),
      });
      toast.success(
        extras?.credentials
          ? 'Connected — credentials tested and saved.'
          : 'Connector instance added.',
      );
      setAdding(null);
      await reload();
    } catch (e: unknown) {
      // Show a toast AND re-throw so the AddForm's inline error block
      // also lights up. Operators were missing the toast when their eye
      // was on the form.
      toast.error(apiErrorMessage(e, 'Add failed.'));
      throw e;
    }
  };

  const activate = async (id: string): Promise<void> => {
    try {
      await Api.updateConnector(id, { isActive: true });
      toast.success('Activated.');
      await reload();
    } catch (e: unknown) {
      toast.error(apiErrorMessage(e, 'Activate failed.'));
    }
  };
  const deactivate = async (id: string): Promise<void> => {
    try {
      await Api.updateConnector(id, { isActive: false });
      toast.success('Deactivated.');
      await reload();
    } catch (e: unknown) {
      toast.error(apiErrorMessage(e, 'Deactivate failed.'));
    }
  };
  const setCreds = async (id: string, creds: unknown): Promise<void> => {
    try {
      await Api.setConnectorCredentials(id, creds);
      toast.success('Credentials saved (encrypted).');
    } catch (e: unknown) {
      toast.error(apiErrorMessage(e, 'Save failed.'));
      throw e;
    }
  };
  const remove = async (id: string): Promise<void> => {
    // No browser confirm — the InstanceCard wraps the Delete button in a
    // <ConfirmDialog> and only calls remove() after the operator confirms.
    try {
      await Api.deleteConnector(id);
      toast.success('Deleted.');
      await reload();
    } catch (e: unknown) {
      toast.error(apiErrorMessage(e, 'Delete failed.'));
      throw e; // ConfirmDialog surfaces it inline and keeps itself open
    }
  };

  const updateInstanceSettings = async (id: string, settings: unknown): Promise<void> => {
    try {
      await Api.updateConnector(id, { settings });
      toast.success('Settings saved.');
      await reload();
    } catch (e: unknown) {
      toast.error(apiErrorMessage(e, 'Save failed.'));
      throw e;
    }
  };

  const setTab = (next: 'configured' | 'available'): void => {
    if (next === 'configured') {
      searchParams.delete('tab');
    } else {
      searchParams.set('tab', 'available');
    }
    setSearchParams(searchParams, { replace: true });
  };

  return (
    <div>
      <PageHeader
        title="Connectors"
        description={
          tab === 'configured'
            ? 'What this install can talk to. Operator picks the active provider per capability.'
            : 'Every provider this install knows about. Toggle on to make it pickable when adding a new instance.'
        }
      />
      <div className="mx-auto max-w-5xl space-y-6 p-6 sm:p-8">
        {/* Tab toggle. Configured = current instances; Available = the
            marketplace formerly at /providers. */}
        <div className="inline-flex rounded-md border border-ink-200 p-0.5 text-sm dark:border-ink-700">
          <button
            className={`rounded-sm px-3 py-1 font-medium transition-colors ${
              tab === 'configured'
                ? 'bg-accent text-white'
                : 'text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-100'
            }`}
            onClick={() => setTab('configured')}
          >
            Configured
          </button>
          <button
            className={`rounded-sm px-3 py-1 font-medium transition-colors ${
              tab === 'available'
                ? 'bg-accent text-white'
                : 'text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-100'
            }`}
            onClick={() => setTab('available')}
          >
            Available
          </button>
        </div>
        {tab === 'available' ? (
          <ProvidersTab />
        ) : (
          <>
        {error && (
          <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">{error}</div>
        )}
        {!caps && <div className="text-sm text-ink-500 dark:text-ink-400">Loading…</div>}
        {caps?.map((cap) => (
          <section key={cap.capability} className="card p-6">
            <header className="mb-4 flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500 dark:text-ink-400">
                  Capability
                </div>
                <h2 className="mt-0.5 text-lg font-semibold tracking-tight">
                  {capabilityLabel(cap.capability)}
                  <span className="ml-2 font-mono text-xs font-normal text-ink-500 dark:text-ink-400">
                    {cap.capability}
                  </span>
                </h2>
              </div>
              {cap.providers.length > 0 && (
                <button
                  className="btn-secondary"
                  onClick={() =>
                    setAdding(adding === cap.capability ? null : cap.capability)
                  }
                >
                  {adding === cap.capability ? 'Cancel' : 'Add instance'}
                </button>
              )}
            </header>

            {cap.providers.length === 0 && (
              <div className="text-sm text-ink-500 dark:text-ink-400">
                No providers enabled for this capability.{' '}
                <button
                  className="text-accent underline hover:text-accent-hover"
                  onClick={() => setTab('available')}
                >
                  Enable one
                </button>
                .
              </div>
            )}

            {adding === cap.capability && (
              <AddForm
                capability={cap.capability}
                providers={cap.providers}
                onAdd={addInstance}
              />
            )}

            {cap.instances.length > 0 && (
              <div className="mt-4 space-y-3">
                {cap.instances.map((inst) => {
                  const provider = cap.providers.find((p) => p.slug === inst.providerSlug);
                  return (
                    <InstanceCard
                      key={inst.id}
                      capability={cap.capability}
                      instance={inst}
                      authKind={provider?.authKind ?? 'none'}
                      externalOAuth={provider?.externalOAuth}
                      settingsSchema={provider?.settingsSchema as FieldSchema | undefined}
                      credentialsSchema={provider?.credentialsSchema as FieldSchema | undefined}
                      onActivate={() => activate(inst.id)}
                      onDeactivate={() => deactivate(inst.id)}
                      onSetCreds={(c) => setCreds(inst.id, c)}
                      onUpdateSettings={(s) => updateInstanceSettings(inst.id, s)}
                      onRemove={() => remove(inst.id)}
                      onAfterConnect={reload}
                    />
                  );
                })}
              </div>
            )}
          </section>
        ))}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Hand-curated model dropdowns per LLM provider. These don't have to mirror
 * the full provider catalog — they're the models we've validated against the
 * connector + that ship with cost-table entries. Operator can override per
 * agent (LlmPicker.model) later.
 */
const KNOWN_LLM_MODELS: Record<string, string[]> = {
  anthropic: [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
};

function AddForm(props: {
  capability: string;
  providers: ConnectorCapability['providers'];
  onAdd: (
    capability: string,
    providerSlug: string,
    displayName: string,
    extras?: { credentials?: Record<string, unknown>; settings?: unknown },
  ) => Promise<void>;
}): JSX.Element {
  const initialProviderSlug = props.providers[0]?.slug ?? '';
  const initialProviderDisplay = props.providers[0]?.displayName ?? '';
  const initialModel =
    props.capability === 'llm' ? (KNOWN_LLM_MODELS[initialProviderSlug] ?? [])[0] ?? '' : '';

  // Auto-format: "Provider · model" for LLM; just "Provider" otherwise.
  const autoDisplayName = (providerDisplay: string, modelId: string): string =>
    modelId ? `${providerDisplay} · ${modelId}` : providerDisplay;

  const [providerSlug, setProviderSlug] = useState(initialProviderSlug);
  const [displayName, setDisplayName] = useState(
    autoDisplayName(initialProviderDisplay, initialModel),
  );
  // Tracks whether the operator hand-edited the display name. As long as
  // this is false, the name stays in sync with provider+model picks. Once
  // they type into the field, we stop overwriting.
  const [displayNameDirty, setDisplayNameDirty] = useState(false);
  const [apiKey, setApiKey] = useState('');
  // Default to the first known model for the initial provider so Save & test
  // isn't disabled before the operator interacts with the model dropdown.
  const [model, setModel] = useState<string>(initialModel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProvider = props.providers.find((p) => p.slug === providerSlug);
  const isLlm = props.capability === 'llm';
  const isApiKey = selectedProvider?.authKind === 'api-key' && !selectedProvider?.externalOAuth;
  const isCustom = selectedProvider?.authKind === 'custom';
  const isExternalOAuth = !!selectedProvider?.externalOAuth;
  const availableModels = isLlm ? KNOWN_LLM_MODELS[providerSlug] ?? [] : [];

  // Schemas the framework auto-renders. For 'custom' auth we render BOTH the
  // credentials form (user/password/whatever) and the settings form (host/port/
  // folders) up front, because verify-on-save needs both to succeed.
  const credSchema = (selectedProvider?.credentialsSchema as FieldSchema | undefined) ?? undefined;
  const settingsSchema = (selectedProvider?.settingsSchema as FieldSchema | undefined) ?? undefined;
  const hasCustomCredFields =
    isCustom &&
    credSchema?.type === 'object' &&
    Object.keys(credSchema.fields).length > 0;
  // Render the settings form inline for both 'custom' AND 'api-key' providers
  // whenever the manifest declares fields. Previously this gated on isCustom
  // only, which meant api-key connectors with required settings (e.g.
  // Resend's defaultFrom) couldn't be created — the server-side Zod parse
  // would reject and dump the raw issues array into the UI.
  const hasSettingsFields =
    (isCustom || isApiKey) &&
    settingsSchema?.type === 'object' &&
    Object.keys(settingsSchema.fields).length > 0;

  const [customCreds, setCustomCreds] = useState<Record<string, unknown>>(() =>
    credSchema ? (defaultFor(credSchema) as Record<string, unknown>) : {},
  );
  const [draftSettings, setDraftSettings] = useState<Record<string, unknown>>(() =>
    settingsSchema ? (defaultFor(settingsSchema) as Record<string, unknown>) : {},
  );

  // Reset custom-credential + settings drafts when the operator switches providers.
  useEffect(() => {
    setCustomCreds(credSchema ? (defaultFor(credSchema) as Record<string, unknown>) : {});
    setDraftSettings(settingsSchema ? (defaultFor(settingsSchema) as Record<string, unknown>) : {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerSlug]);

  // Reset model + auto-name when provider switches.
  function pickProvider(slug: string) {
    setProviderSlug(slug);
    const p = props.providers.find((x) => x.slug === slug);
    const newProviderDisplay = p?.displayName ?? '';
    const models = (isLlm ? KNOWN_LLM_MODELS[slug] : undefined) ?? [];
    const newModel = models[0] ?? '';
    setModel(newModel);
    if (!displayNameDirty) {
      setDisplayName(autoDisplayName(newProviderDisplay, newModel));
    }
    setApiKey('');
    setError(null);
  }

  function pickModel(modelId: string) {
    setModel(modelId);
    if (!displayNameDirty) {
      setDisplayName(autoDisplayName(selectedProvider?.displayName ?? '', modelId));
    }
  }

  // For 'custom' auth, require every non-optional credential field to be
  // filled in before enabling Save & test. Optional fields can stay blank.
  const customCredsFilled =
    !isCustom ||
    !hasCustomCredFields ||
    (credSchema?.type === 'object' &&
      Object.entries(credSchema.fields).every(([k, f]) => {
        const isOptional = (f as { optional?: boolean }).optional;
        const v = customCreds[k];
        return isOptional || (typeof v === 'string' ? v.length > 0 : v != null);
      }));

  const canSave =
    !busy &&
    !!providerSlug &&
    !!displayName &&
    (isExternalOAuth || !isApiKey || !!apiKey) &&
    customCredsFilled &&
    (!isLlm || !availableModels.length || !!model);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const extras: { credentials?: Record<string, unknown>; settings?: unknown } = {};
      if (isApiKey && apiKey) {
        extras.credentials = { kind: 'api-key', key: apiKey };
      }
      if (isCustom && hasCustomCredFields) {
        extras.credentials = { kind: 'custom', values: customCreds };
      }
      if (hasSettingsFields) {
        extras.settings = draftSettings;
      }
      if (isLlm && model) {
        // Stamp the chosen model as the connector instance's default. Per-agent
        // override is still available via LlmPicker.model.
        extras.settings = { defaultModel: model };
      }
      await props.onAdd(props.capability, providerSlug, displayName, extras);
    } catch (e: unknown) {
      // verify_failed and other 400s carry the human message on body.message;
      // apiErrorMessage knows how to dig it out.
      setError(apiErrorMessage(e, 'Save failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-md border border-ink-200 bg-ink-50 p-4 dark:border-ink-700 dark:bg-ink-950/40">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Provider</label>
          <select
            className="input"
            value={providerSlug}
            onChange={(e) => pickProvider(e.target.value)}
          >
            {props.providers.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Display name</label>
          <input
            className="input"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setDisplayNameDirty(true);
            }}
            placeholder="auto-filled — edit to override"
          />
        </div>
        {isLlm && availableModels.length > 0 && (
          <div>
            <label className="label">Default model</label>
            <select
              className="input"
              value={model || availableModels[0]}
              onChange={(e) => pickModel(e.target.value)}
            >
              {availableModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        )}
        {isApiKey && (
          <div className={isLlm && availableModels.length > 0 ? '' : 'sm:col-span-1'}>
            <label className="label">API key</label>
            <input
              className="input-mono"
              // Plain text — keeps Chrome/1Password from nagging on what is
              // an API token, not a password.
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              placeholder="paste here"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setError(null);
              }}
            />
          </div>
        )}
        {isExternalOAuth && (
          <div className="sm:col-span-2 text-xs text-ink-500 dark:text-ink-400">
            This provider uses {selectedProvider!.externalOAuth!.provider}. Click Save to add
            it; you'll connect the account from the instance card.
          </div>
        )}
      </div>
      {isCustom && hasCustomCredFields && credSchema && (
        <div className="mt-4 border-t border-ink-200 pt-4 dark:border-ink-700">
          <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
            Credentials
          </h4>
          <SchemaForm
            schema={credSchema}
            value={customCreds}
            onChange={(v) => {
              setCustomCreds((v ?? {}) as Record<string, unknown>);
              setError(null);
            }}
            noAutofill
          />
        </div>
      )}
      {hasSettingsFields && settingsSchema && (
        <div className="mt-4 border-t border-ink-200 pt-4 dark:border-ink-700">
          <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
            Connection settings
          </h4>
          <SchemaForm
            schema={settingsSchema}
            value={draftSettings}
            onChange={(v) => setDraftSettings((v ?? {}) as Record<string, unknown>)}
          />
        </div>
      )}
      {error && (
        <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
          {error}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button className="btn-primary" disabled={!canSave} onClick={submit}>
          {busy ? 'Testing…' : isApiKey || isCustom ? 'Save & test' : 'Save'}
        </button>
        <span className="text-xs text-ink-500 dark:text-ink-400">
          {isApiKey || isCustom
            ? 'We test the connection before saving — nothing persists if it fails.'
            : null}
        </span>
      </div>
    </div>
  );
}

function InstanceCard(props: {
  capability: string;
  instance: ConnectorCapability['instances'][number];
  authKind: 'oauth2' | 'api-key' | 'none' | 'custom';
  externalOAuth?: { provider: 'composio'; toolkit: string };
  settingsSchema?: FieldSchema;
  credentialsSchema?: FieldSchema;
  onActivate: () => Promise<void>;
  onDeactivate: () => Promise<void>;
  onSetCreds: (creds: unknown) => Promise<void>;
  onUpdateSettings: (settings: unknown) => Promise<void>;
  onRemove: () => Promise<void>;
  /** Called after a successful external-OAuth connection so parent reloads. */
  onAfterConnect: () => Promise<void>;
}): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [credsSaved, setCredsSaved] = useState(false);
  const [credsError, setCredsError] = useState<string | null>(null);
  // Hide the API key form by default — most operators set it once and
  // never touch it again. Click "Update key" to reveal.
  const [editingKey, setEditingKey] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'err'>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<unknown>(props.instance.settings ?? {});
  const [settingsSaveState, setSettingsSaveState] = useState<'idle' | 'saving' | 'ok' | 'error'>(
    'idle',
  );
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Custom (username/password/etc.) credential editing. Unlike api-key, these
  // connectors previously had NO in-place edit path — the only way to change a
  // password was to delete and re-add the instance. This form lets an operator
  // update the saved credentials in place (they re-enter the fields; we never
  // echo the stored secret back). Save runs the same auto-test as first setup.
  const hasCredSchema =
    props.credentialsSchema &&
    props.credentialsSchema.type === 'object' &&
    Object.keys((props.credentialsSchema as { fields: object }).fields).length > 0;
  const [editingCreds, setEditingCreds] = useState(false);
  const [draftCreds, setDraftCreds] = useState<Record<string, unknown>>(() =>
    props.credentialsSchema ? (defaultFor(props.credentialsSchema) as Record<string, unknown>) : {},
  );
  const [credSaveState, setCredSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const draftCredsFilled =
    !hasCredSchema ||
    (props.credentialsSchema?.type === 'object' &&
      Object.entries(props.credentialsSchema.fields).every(([k, f]) => {
        const isOptional = (f as { optional?: boolean }).optional;
        const v = draftCreds[k];
        return isOptional || (typeof v === 'string' ? v.length > 0 : v != null);
      }));

  const hasSettingsSchema =
    props.settingsSchema &&
    props.settingsSchema.type === 'object' &&
    Object.keys((props.settingsSchema as { fields: object }).fields).length > 0;

  return (
    <div className="rounded-md border border-ink-200 bg-white p-4 transition-colors dark:border-ink-700 dark:bg-ink-900">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink-900 dark:text-ink-100">
              {props.instance.displayName}
            </span>
            {props.instance.isActive ? (
              <span className="pill-ok">connected</span>
            ) : (
              <span className="pill-muted">not connected</span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-xs text-ink-500 dark:text-ink-400">
            {props.instance.providerSlug} · {props.authKind} · added{' '}
            {new Date(props.instance.createdAt).toLocaleDateString()}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {props.externalOAuth && (
            <ConnectButton
              instanceId={props.instance.id}
              toolkit={props.externalOAuth.toolkit}
              broker={props.externalOAuth.provider}
              onConnected={props.onAfterConnect}
            />
          )}
          {/*
            Action layout — state-aware, surfaces ONE primary CTA at a time:
              - external OAuth (Composio) → ConnectButton
              - no creds yet              → "Set key" (primary)
              - creds saved, not active   → "Test connection" (primary), Update key (ghost)
              - active                    → Update key (ghost), Disconnect (secondary)
            Settings + Delete are quieter, always present.
          */}
          {!props.externalOAuth && props.authKind === 'api-key' && !editingKey && (
            <>
              {!props.instance.hasCredentials && (
                <button
                  className="btn-primary"
                  onClick={() => {
                    setEditingKey(true);
                    setCredsSaved(false);
                    setCredsError(null);
                  }}
                >
                  Set key
                </button>
              )}
              {props.instance.hasCredentials && !props.instance.isActive && (
                <button
                  className="btn-primary"
                  disabled={testState === 'testing'}
                  onClick={async () => {
                    setTestState('testing');
                    setTestError(null);
                    try {
                      const res = await Api.testConnector(props.instance.id);
                      if (res.ok) {
                        setTestState('ok');
                        await props.onActivate();
                      } else {
                        setTestState('err');
                        setTestError(res.error);
                      }
                    } catch (e: unknown) {
                      setTestState('err');
                      setTestError(e instanceof Error ? e.message : 'test failed');
                    }
                  }}
                >
                  {testState === 'testing' ? 'Testing…' : 'Test connection'}
                </button>
              )}
              {props.instance.hasCredentials && (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setEditingKey(true);
                    setCredsSaved(false);
                    setCredsError(null);
                  }}
                >
                  Update key
                </button>
              )}
            </>
          )}
          {!props.externalOAuth && props.authKind === 'api-key' && editingKey && (
            <div>
              <label className="label">API key</label>
              <div className="flex items-center gap-2">
                <input
                  className="input-mono w-72"
                  // `text` (not `password`) — keeps Chrome / 1Password from
                  // pestering with "save / update password" prompts that don't
                  // apply to API tokens. Operators are pasting from a
                  // password manager elsewhere; visible-while-pasting is fine.
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                  placeholder="paste here"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setCredsSaved(false);
                    setCredsError(null);
                  }}
                  autoFocus
                />
                <button
                  className="btn-secondary"
                  disabled={!apiKey}
                  onClick={async () => {
                    try {
                      await props.onSetCreds({ kind: 'api-key', key: apiKey });
                      setApiKey('');
                      setCredsSaved(true);
                      setEditingKey(false);
                    } catch (e: unknown) {
                      // PUT /credentials now auto-tests on the server;
                      // verify_failed comes back as 400 with body.message
                      // holding the provider's actual error.
                      setCredsError(apiErrorMessage(e, 'Save failed.'));
                    }
                  }}
                >
                  Save & test
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setEditingKey(false);
                    setApiKey('');
                    setCredsError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
              {credsSaved && <div className="mt-1 text-xs text-ok">Saved (encrypted).</div>}
              {credsError && <div className="mt-1 text-xs text-bad">{credsError}</div>}
            </div>
          )}
          {props.authKind === 'custom' && hasCredSchema && (
            <button
              className="btn-ghost"
              onClick={() => {
                setEditingCreds((v) => !v);
                setCredSaveState('idle');
                setCredsError(null);
                // Start from a blank/default form each time — we can't (and
                // shouldn't) prefill the stored secret.
                setDraftCreds(
                  props.credentialsSchema
                    ? (defaultFor(props.credentialsSchema) as Record<string, unknown>)
                    : {},
                );
              }}
            >
              {props.instance.hasCredentials ? 'Update credentials' : 'Set credentials'}
            </button>
          )}
          {hasSettingsSchema && (
            <button
              className="btn-ghost"
              onClick={() => setShowSettings(!showSettings)}
            >
              {showSettings ? 'Hide settings' : 'Settings'}
            </button>
          )}
          {props.instance.isActive ? (
            <button className="btn-secondary" onClick={props.onDeactivate}>
              Disconnect
            </button>
          ) : null}
          <ConfirmDialog
            title="Delete this connector instance?"
            description={
              <>
                <span className="font-medium text-ink-800 dark:text-ink-200">
                  {props.instance.displayName}
                </span>{' '}
                will be removed and its saved credentials wiped. Any agent
                bound to this instance will lose its binding.
              </>
            }
            confirmLabel="Delete"
            variant="danger"
            onConfirm={props.onRemove}
          >
            <button className="btn-danger">Delete</button>
          </ConfirmDialog>
        </div>
        {testError && (
          <div className="mt-2 text-xs text-bad">{testError}</div>
        )}
      </div>
      {/* settings section */}
      {showSettings && hasSettingsSchema && props.settingsSchema && (
        <div className="divider mt-4 pt-4">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
            Provider settings
          </h3>
          <SchemaForm
            schema={props.settingsSchema}
            value={draftSettings}
            onChange={setDraftSettings}
          />
          {settingsError && (
            <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
              {settingsError}
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              className="btn-primary"
              disabled={settingsSaveState === 'saving'}
              onClick={async () => {
                setSettingsSaveState('saving');
                setSettingsError(null);
                try {
                  await props.onUpdateSettings(draftSettings);
                  setSettingsSaveState('ok');
                  setTimeout(() => setSettingsSaveState('idle'), 1500);
                } catch (e: unknown) {
                  setSettingsSaveState('error');
                  setSettingsError(e instanceof Error ? e.message : 'save failed');
                }
              }}
            >
              {settingsSaveState === 'saving' ? 'Saving…' : 'Save settings'}
            </button>
            {settingsSaveState === 'ok' && <span className="text-xs text-ok">Saved.</span>}
          </div>
        </div>
      )}
      {/* update-credentials section (custom auth: username/password/etc.) */}
      {editingCreds && props.authKind === 'custom' && hasCredSchema && props.credentialsSchema && (
        <div className="divider mt-4 pt-4">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
            Update credentials
          </h3>
          <SchemaForm
            schema={props.credentialsSchema}
            value={draftCreds}
            onChange={(v) => {
              setDraftCreds((v ?? {}) as Record<string, unknown>);
              setCredSaveState('idle');
              setCredsError(null);
            }}
            noAutofill
          />
          {credsError && (
            <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200">
              {credsError}
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              className="btn-primary"
              disabled={credSaveState === 'saving' || !draftCredsFilled}
              onClick={async () => {
                setCredSaveState('saving');
                setCredsError(null);
                try {
                  await props.onSetCreds({ kind: 'custom', values: draftCreds });
                  setCredSaveState('idle');
                  setEditingCreds(false);
                } catch (e: unknown) {
                  // PUT /credentials auto-tests server-side; a verify_failed
                  // returns 400 with the provider's real message.
                  setCredSaveState('error');
                  setCredsError(apiErrorMessage(e, 'Save failed — check the details and try again.'));
                }
              }}
            >
              {credSaveState === 'saving' ? 'Testing…' : 'Save & test'}
            </button>
            <button
              className="btn-ghost"
              onClick={() => {
                setEditingCreds(false);
                setCredsError(null);
              }}
            >
              Cancel
            </button>
            <span className="text-xs text-ink-500 dark:text-ink-400">
              We test the connection before saving — nothing changes if it fails.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * External-OAuth "Connect" button. Opens the broker's consent URL in a popup
 * and polls the server every 2s until the broker reports an ACTIVE connection
 * (or the operator gives up). Reloads the parent on success so the new
 * connection state + active badge surface immediately.
 */
function ConnectButton(props: {
  instanceId: string;
  toolkit: string;
  broker: 'composio';
  onConnected: () => Promise<void>;
}): JSX.Element {
  const { toast } = useToast();
  const [busy, setBusy] = useState<'idle' | 'awaiting' | 'finalizing'>('idle');

  const start = async (): Promise<void> => {
    setBusy('awaiting');
    let popup: Window | null = null;
    try {
      const { redirectUrl } = await Api.connectConnector(props.instanceId);
      popup = window.open(redirectUrl, `${props.broker}-connect-${props.instanceId}`, 'width=600,height=720');
      if (!popup) {
        toast.error('Pop-up blocked. Allow pop-ups and try again.');
        setBusy('idle');
        return;
      }

      // Poll for completion. Stop on success, on the popup closing without a
      // connection (operator cancelled), or after 5 minutes.
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const out = await Api.finalizeConnectConnector(props.instanceId);
        if ('ok' in out && out.ok) {
          setBusy('idle');
          try { popup.close(); } catch { /* ignore */ }
          toast.success(`${props.toolkit} connected.`);
          await props.onConnected();
          return;
        }
        if (popup.closed) {
          setBusy('idle');
          toast.error('Connect window closed before authorization completed.');
          return;
        }
      }
      setBusy('idle');
      toast.error('Connect timed out. Try again.');
      try { popup.close(); } catch { /* ignore */ }
    } catch (e: unknown) {
      setBusy('idle');
      toast.error(apiErrorMessage(e, 'Connect failed.'));
      try { popup?.close(); } catch { /* ignore */ }
    }
  };

  return (
    <button className="btn-primary" disabled={busy !== 'idle'} onClick={start}>
      {busy === 'awaiting' ? 'Waiting for consent…' : `Connect ${props.toolkit}`}
    </button>
  );
}
