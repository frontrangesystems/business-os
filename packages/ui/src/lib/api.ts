/**
 * Thin fetch wrapper that talks to the framework's REST API.
 *
 * All requests are credentialed (httpOnly cookie) and JSON. Server errors
 * surface as ApiError so pages can `instanceof`-check.
 */

import type { FriendlySchedule } from '@frontrangesystems/business-os-agent-sdk';

export type { FriendlySchedule } from '@frontrangesystems/business-os-agent-sdk';

// Re-exported so anonymous routes (password reset, etc.) can call the raw api
// helper without importing from the typed Api object.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {  // eslint-disable-line @typescript-eslint/no-unused-vars
  const { method = 'GET', body, signal } = opts;
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  let parsedBody: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }

  if (!res.ok) {
    const message =
      (parsedBody && typeof parsedBody === 'object' && 'error' in parsedBody
        ? String((parsedBody as { error: unknown }).error)
        : null) ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, message, parsedBody);
  }
  return parsedBody as T;
}

// ----- Typed wrappers -----

export type Theme = 'light' | 'dark' | 'system';

export interface Me {
  user: { id: string; email: string; roles: string[]; displayName?: string | null } | null;
  totpEnrolled?: boolean;
  preferences?: { theme: Theme };
}

/** Audience tag as sent by the server (V1: everyone | admins). */
export type WireAudience = { kind: 'everyone' } | { kind: 'admins' };

export interface ManagedUser {
  id: string;
  email: string;
  displayName: string | null;
  isActive: boolean;
  roles: string[];
}

export interface TotpEnrollResponse {
  secret: string;
  otpauthUri: string;
}

export interface AgentManifest {
  slug: string;
  version: string;
  displayName: string;
  description: string;
  requiredConnectors: string[];
  schedule: { kind: 'cron'; expr: string } | { kind: 'manual' } | { kind: 'event'; topic: string };
}

export interface AgentSummary extends AgentManifest {
  /**
   * Effective schedule (operator override ?? manifest) in human-readable
   * friendly form, plus a pre-rendered label. The list renders
   * `scheduleDescription`; the raw `schedule` field is kept for back-compat.
   * Both are optional so older API responses don't break typing.
   */
  effectiveSchedule?: FriendlySchedule;
  scheduleDescription?: string;
  settings: unknown;
  /**
   * Discriminated-union description of the agent's settings schema, produced
   * by zodToFieldSchema on the server. Used by the UI to auto-render the
   * settings form.
   */
  settingsSchema?: unknown;
  /** Same shape as settingsSchema; only set when the agent declared an inputSchema. */
  inputSchema?: unknown | null;
  /**
   * Per-agent connector instance bindings. `{ [capability]: instanceId }`.
   * Set via PUT /api/agents/:slug/bindings. Agents fail loud at run time
   * if a required capability has no binding here.
   */
  connectorBindings?: Record<string, string>;
  lastRun: AgentRun | null;
}

export interface AgentRun {
  id: string;
  startedAt: string;
  endedAt: string | null;
  ok: boolean | null;
  summary: string | null;
  trigger?: string;
  triggeredBy?: string | null;
}

/** A module-contributed dashboard card (see module-sdk DashboardContribution). */
export interface DashboardCard {
  moduleSlug: string;
  title: string;
  summary?: string;
  items: Array<{ title: string; subtitle?: string; href?: string; badge?: string }>;
  emptyText?: string;
  ctaLabel?: string;
  ctaHref?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  userId: string | null;
  userEmail: string | null;
  agentSlug: string | null;
  requestId: string | null;
  meta: Record<string, unknown> | null;
}

export interface ConnectorCapability {
  capability: string;
  providers: Array<{
    slug: string;
    displayName: string;
    authKind: 'oauth2' | 'api-key' | 'none' | 'custom';
    /** Set when the provider uses an external OAuth broker (Composio etc.). */
    externalOAuth?: { provider: 'composio'; toolkit: string };
    version: string;
    settingsSchema?: unknown;
    /** Present when authKind === 'custom'. Drives the Add form's credentials fields. */
    credentialsSchema?: unknown;
  }>;
  instances: Array<{
    id: string;
    providerSlug: string;
    displayName: string;
    isActive: boolean;
    createdAt: string;
    settings?: unknown;
    /**
     * True iff credentials have been saved for this instance. Drives which
     * action the operator UI surfaces (Set key / Test / Update key).
     */
    hasCredentials: boolean;
  }>;
}

export const Api = {
  me: () => api<Me>('/auth/me'),
  login: (email: string, password: string, totp?: string) =>
    api('/auth/login', { method: 'POST', body: { email, password, totp } }),
  logout: () => api('/auth/logout', { method: 'POST' }),

  enrollTotp: () => api<TotpEnrollResponse>('/auth/totp/enroll', { method: 'POST' }),
  confirmTotp: (code: string) =>
    api<{ ok: true }>('/auth/totp/confirm', { method: 'POST', body: { code } }),
  disableTotp: (code: string) =>
    api<{ ok: true }>('/auth/totp/disable', { method: 'POST', body: { code } }),

  updatePreferences: (patch: { theme?: Theme }) =>
    api<{ ok: true; preferences: { theme: Theme } }>('/auth/me/preferences', {
      method: 'PATCH',
      body: patch,
    }),

  listModules: () =>
    api<{
      modules: Array<{
        slug: string;
        version: string;
        displayName: string;
        description: string;
        defaultAudience?: WireAudience;
        uiPages: Array<{ path: string; navLabel?: string; audience?: WireAudience }>;
        settings: unknown;
        settingsSchema: unknown;
        /** Connector capabilities the module binds to instances. */
        requiredConnectors: string[];
        /** capability -> bound connector instance id. */
        connectorBindings: Record<string, string>;
      }>;
    }>('/api/modules'),

  updateModuleSettings: (slug: string, value: unknown) =>
    api<{ ok: true; settings: unknown }>(`/api/modules/${slug}/settings`, {
      method: 'PUT',
      body: { value },
    }),

  updateModuleBindings: (slug: string, bindings: Record<string, string>) =>
    api<{ ok: true; bindings: Record<string, string> }>(`/api/modules/${slug}/bindings`, {
      method: 'PUT',
      body: { bindings },
    }),

  // ----- User management (admin-only on the server) -----
  listUsers: () => api<{ users: ManagedUser[] }>('/api/users'),
  createUser: (body: {
    email: string;
    displayName?: string;
    roles?: string[];
  }) => api<{ user: ManagedUser }>('/api/users', { method: 'POST', body }),
  setUserRoles: (id: string, roles: string[]) =>
    api<{ ok: true; roles: string[] }>(`/api/users/${id}/roles`, {
      method: 'PATCH',
      body: { roles },
    }),
  updateUser: (id: string, body: { isActive?: boolean; displayName?: string }) =>
    api<{ ok: true; user: ManagedUser }>(`/api/users/${id}`, {
      method: 'PATCH',
      body,
    }),

  /** Dashboard cards contributed by modules (the default landing page). */
  getDashboard: () => api<{ cards: DashboardCard[] }>('/api/dashboard'),

  /** Install status (agents, recent runs, capability coverage) — admin only. */
  getStatus: () =>
    api<{
      agentCount: number;
      recentRuns: Array<AgentRun & { agentSlug: string }>;
      capabilities: Array<{
        capability: string;
        registered: number;
        configured: number;
        activeProvider: string | null;
      }>;
    }>('/api/status'),

  listAgents: () => api<{ agents: AgentSummary[] }>('/api/agents'),
  /** Agents the install knows about but the operator hasn't enabled yet. */
  listAvailableAgents: () =>
    api<{
      agents: Array<{
        slug: string;
        version: string;
        displayName: string;
        description: string;
        requiredConnectors: ReadonlyArray<string>;
        schedule: { kind: 'cron'; expr: string } | { kind: 'manual' } | { kind: 'event'; topic: string };
        settingsSchema?: unknown;
      }>;
    }>('/api/agents/available'),
  enableAgent: (
    slug: string,
    body: { settings?: unknown; bindings?: Record<string, string> },
  ) =>
    api<{ ok: true }>(`/api/agents/${slug}/enable`, {
      method: 'POST',
      body,
    }),
  disableAgent: (slug: string) =>
    api<{ ok: true }>(`/api/agents/${slug}/disable`, { method: 'POST' }),
  getAgentSchedule: (slug: string) =>
    api<{
      manifest: FriendlySchedule;
      override: FriendlySchedule | null;
      effective: FriendlySchedule;
      description: string;
      nextRunAt: string | null;
      supportedTriggers: Array<'cron' | 'manual' | 'event'>;
      availableEventTopics: Array<{ topic: string; displayName: string; via: string }>;
    }>(`/api/agents/${slug}/schedule`),
  setAgentSchedule: (slug: string, override: FriendlySchedule | null) =>
    api<{ ok: true; override: typeof override }>(`/api/agents/${slug}/schedule`, {
      method: 'PUT',
      body: { override },
    }),
  getAgent: (slug: string) => api<AgentSummary>(`/api/agents/${slug}`),
  updateAgentSettings: (slug: string, value: unknown) =>
    api<{ ok: true; settings: unknown }>(`/api/agents/${slug}/settings`, {
      method: 'PUT',
      body: { value },
    }),
  updateAgentBindings: (slug: string, bindings: Record<string, string>) =>
    api<{ ok: true; bindings: Record<string, string> }>(
      `/api/agents/${slug}/bindings`,
      { method: 'PUT', body: { bindings } },
    ),
  runAgent: (slug: string, input: unknown) =>
    api<{ ok: true }>(`/api/agents/${slug}/run`, {
      method: 'POST',
      body: { input },
    }),
  listRuns: (slug: string, opts: { limit?: number; before?: string } = {}) => {
    const q = new URLSearchParams();
    q.set('limit', String(opts.limit ?? 50));
    if (opts.before) q.set('before', opts.before);
    return api<{ runs: AgentRun[]; nextBefore: string | null }>(
      `/api/agents/${slug}/runs?${q.toString()}`,
    );
  },

  getRun: (id: string) =>
    api<{
      run: AgentRun & { agentSlug: string; details: unknown };
      audits: AuditEntry[];
    }>(`/api/runs/${id}`),

  listAudit: (opts: {
    limit?: number;
    action?: string;
    userId?: string;
    agentSlug?: string;
    since?: string;
    before?: string;
  } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.action) q.set('action', opts.action);
    if (opts.userId) q.set('userId', opts.userId);
    if (opts.agentSlug) q.set('agentSlug', opts.agentSlug);
    if (opts.since) q.set('since', opts.since);
    if (opts.before) q.set('before', opts.before);
    const s = q.toString();
    return api<{ entries: AuditEntry[]; nextBefore: string | null }>(
      `/api/audit${s ? '?' + s : ''}`,
    );
  },

  listConnectors: () => api<{ capabilities: ConnectorCapability[] }>('/api/connectors'),
  listProviders: () =>
    api<{
      capabilities: Array<{
        capability: string;
        providers: Array<{
          slug: string;
          displayName: string;
          authKind: 'oauth2' | 'api-key' | 'none';
          externalOAuth?: { provider: 'composio'; toolkit: string };
          version: string;
          enabled: boolean;
        }>;
      }>;
    }>('/api/providers'),
  setProviderEnabled: (capability: string, slug: string, enabled: boolean) =>
    api<{ ok: true; enabled: boolean }>(
      `/api/providers/${encodeURIComponent(capability)}/${encodeURIComponent(slug)}`,
      { method: 'PUT', body: { enabled } },
    ),
  createConnector: (body: {
    capability: string;
    providerSlug: string;
    displayName: string;
    /**
     * Optional one-shot setup. When provided, the server runs verify()
     * BEFORE persisting. On verify failure, nothing is written and the
     * call rejects with the provider's error. On success, the instance
     * is created + active in one round-trip.
     */
    credentials?: Record<string, unknown>;
    settings?: unknown;
  }) => api<{ instance: ConnectorCapability['instances'][number] }>(`/api/connectors`, {
    method: 'POST',
    body,
  }),
  updateConnector: (
    id: string,
    body: { displayName?: string; isActive?: boolean; settings?: unknown },
  ) =>
    api<{ instance: ConnectorCapability['instances'][number] }>(`/api/connectors/${id}`, {
      method: 'PATCH',
      body,
    }),
  setConnectorCredentials: (id: string, credentials: unknown) =>
    api<{ ok: true }>(`/api/connectors/${id}/credentials`, {
      method: 'PUT',
      body: { credentials },
    }),
  deleteConnector: (id: string) =>
    api<{ ok: true }>(`/api/connectors/${id}`, { method: 'DELETE' }),
  /**
   * Calls the connector's verify() hook. Cheap auth probe — no billable
   * tokens. Returns ok=true on success, or ok=false with an error message.
   */
  testConnector: (id: string) =>
    api<{ ok: true; message?: string } | { ok: false; error: string }>(
      `/api/connectors/${id}/test`,
      { method: 'POST' },
    ),

  /**
   * Initiate the external-OAuth flow for a Composio-backed instance.
   * Returns a URL the caller should open in a popup; user grants access at
   * the provider, then the caller polls finalizeConnectConnector.
   */
  connectConnector: (id: string) =>
    api<{ redirectUrl: string }>(`/api/connectors/${id}/connect`, { method: 'POST' }),
  /**
   * Poll for connection completion. Returns { pending: true } until the
   * broker reports an ACTIVE connection, then { ok: true, connectedAccountId }.
   */
  finalizeConnectConnector: (id: string) =>
    api<{ ok: true; connectedAccountId: string } | { pending: true }>(
      `/api/connectors/${id}/finalize-connect`,
      { method: 'POST' },
    ),

  // ---------------------------------------------------------------------------
  // Platform settings
  // ---------------------------------------------------------------------------

  /**
   * Returns whether the Composio API key has been configured by the operator.
   * Never returns the key value — only the configured status.
   */
  getComposioSettings: () =>
    api<{ configured: boolean }>('/api/platform/composio'),

  /**
   * Save (or replace) the Composio API key. The key is encrypted at rest.
   * On success, Composio-backed connectors can initiate OAuth flows.
   */
  setComposioApiKey: (apiKey: string) =>
    api<{ ok: true }>('/api/platform/composio', { method: 'PUT', body: { apiKey } }),

  /** Returns the full set of assignable roles (admin + any client-defined custom roles). */
  getRoles: () =>
    api<{ roles: Array<{ value: string; label: string }> }>('/api/roles'),
};
