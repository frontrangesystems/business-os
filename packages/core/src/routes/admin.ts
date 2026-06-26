import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, desc, and, gte, lt, sql, type SQL } from 'drizzle-orm';
import {
  agentRuns,
  auditLog,
  settings as settingsTable,
  connectorInstances,
  users,
} from '@frontrangesystems/business-os-db';
import type { Db } from '@frontrangesystems/business-os-db';
import {
  FriendlyScheduleSchema,
  describeSchedule,
  cronToFriendly,
  nextRun,
  type FriendlySchedule,
} from '@frontrangesystems/business-os-agent-sdk';
import { requireUser, requireRole } from './_require-user.js';
import { zodToFieldSchema } from '../zod-form.js';
import { AGENT_REFRESH_CHANNEL } from '../agent-refresh.js';
import type { ExternalOAuthBrokerLike } from '../inventory.js';

/**
 * Cross-process live refresh: after persisting an enable/disable/schedule
 * change in the api process, notify the worker process (which hosts the
 * scheduler) so it re-reads the agent's state immediately. Best-effort — a
 * notify failure must never break the request; the change is already
 * persisted and will take effect on next worker restart regardless.
 *
 * Both args to pg_notify are parameterized (it's a function, not the bare
 * NOTIFY statement, so the channel name binds safely).
 */
async function notifyAgentRefresh(db: Db, slug: string): Promise<void> {
  await db
    .execute(sql`select pg_notify(${AGENT_REFRESH_CHANNEL}, ${slug})`)
    .catch(() => {});
}

/**
 * Admin / operator API.
 *
 * Surface the framework's runtime state through REST so any operator UI
 * (or curl, for now) can:
 *   - list registered agents and their current settings
 *   - update agent settings (validated against the manifest's Zod schema)
 *   - trigger a manual run
 *   - list recent agent_runs
 *   - list registered connector providers per capability
 *   - register a connector instance, mark it active, set its settings,
 *     and store encrypted credentials (via SecretsStore — bytes never
 *     leave that interface)
 *
 * Every endpoint requires an authenticated session (requireUser). On top of
 * that, every state-changing / admin action is gated with
 * `requireRole('admin')` — read-only endpoints (lists, detail GETs, dashboard,
 * audit view) stay available to any logged-in user. The preHandlers compose as
 * `[requireUser, requireRole('admin')]` so requireUser populates req.user
 * (incl. roles) before requireRole inspects it.
 */

/**
 * Audience tag, normalized for the wire. Mirrors module-sdk's AudienceTag but
 * declared here to avoid core depending on module-sdk at value level. V1
 * enforces only 'everyone' vs 'admins'; 'departments' is mapped to 'everyone'
 * (department-scoping comes later) and anything unrecognized falls back to
 * 'everyone' (fail-open for *visibility* only — never for write authz, which is
 * always requireRole-gated server-side).
 */
type WireAudience = { kind: 'everyone' } | { kind: 'admins' };

function normalizeAudience(value: unknown): WireAudience {
  if (value && typeof value === 'object' && 'kind' in value) {
    const kind = (value as { kind?: unknown }).kind;
    if (kind === 'admins') return { kind: 'admins' };
  }
  // everyone, departments (V1), or unknown → everyone
  return { kind: 'everyone' };
}

const SETTINGS_AGENT_SCOPE = (slug: string): string => `agent:${slug}`;
const SETTINGS_AGENT_BINDINGS_SCOPE = (slug: string): string => `agent-bindings:${slug}`;
const SETTINGS_CONNECTOR_SCOPE = (cap: string, id: string): string =>
  `connector:${cap}:${id}`;
const SECRETS_CONNECTOR_SCOPE = SETTINGS_CONNECTOR_SCOPE;
const CREDENTIAL_KEY = 'credentials';
/**
 * Per-install enable/disable flag for a (capability, providerSlug) pair.
 * Persisted in the `settings` table. Disabled providers stay registered in
 * memory (the runtime always knows about them) but the operator UI hides
 * them from the Add Instance dropdown until re-enabled.
 *
 * Default when no row exists: enabled.
 */
const PROVIDER_ENABLED_SCOPE = (cap: string, slug: string): string =>
  `provider:${cap}:${slug}`;

/**
 * Per-install enable/disable flag for an agent. Persisted in `settings`.
 * Differs from providers in default behavior: missing row = DISABLED.
 * Operators add agents explicitly via the Add Agent flow; uninstalled
 * agents stay registered but don't appear on /agents and don't fire on
 * any schedule. Disabling preserves runs, settings, bindings, schedule
 * so re-enabling later doesn't lose history.
 *
 * Brownfield-safe: a one-time boot seed enables every currently-registered
 * agent on first run after this PR. See `seedAgentEnabledIfNeeded`.
 */
const AGENT_ENABLED_SCOPE = (slug: string): string => `agent-enabled:${slug}`;

/**
 * Per-install operator override of the agent's manifest-declared schedule.
 * Persisted in `settings`. Missing row OR `{ kind: 'manifest' }` = honor
 * manifest. Otherwise the override wins. Effective = override ?? manifest.
 */
const AGENT_SCHEDULE_SCOPE = (slug: string): string => `agent-schedule:${slug}`;

/**
 * Tracks an active Composio (or future broker) event subscription tied to
 * (connectorInstanceId, topic). Storing the subscriptionId lets the framework
 * unsubscribe later when an agent leaves event-mode or the binding changes.
 * One row per (instanceId, topic) pair.
 */
const CONNECTOR_EVENT_SUB_SCOPE = (instanceId: string, topic: string): string =>
  `connector-event-sub:${instanceId}:${topic}`;

/**
 * The schedule override stored per-install is now the human-readable
 * `FriendlySchedule` (interval / daily / weekly / manual / event, plus a raw
 * cron escape hatch). The friendly kinds are translated to cron by the runtime;
 * the operator never sees a raw expression in the primary UI.
 *
 * Backward-compat: legacy overrides were persisted as `{kind:'cron',expr}` /
 * `{kind:'manual'}` / `{kind:'event',topic}`. Those are a strict subset of the
 * friendly union, so they continue to validate + load unchanged.
 */
type ScheduleOverride = FriendlySchedule;

const ScheduleOverrideSchema = FriendlyScheduleSchema;

async function loadScheduleOverride(db: Db, slug: string): Promise<ScheduleOverride | null> {
  const rows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.scope, AGENT_SCHEDULE_SCOPE(slug)))
    .limit(1);
  const v = rows[0]?.value;
  if (!v) return null;
  const parsed = ScheduleOverrideSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

/**
 * Map a schedule's `kind` to the manifest-level trigger kind it satisfies, for
 * the `supportedTriggers` gate. The friendly time-based kinds (interval / daily
 * / weekly) and the raw `cron` escape hatch all count as the `'cron'` trigger.
 */
function triggerKindOf(kind: FriendlySchedule['kind']): 'cron' | 'manual' | 'event' {
  if (kind === 'manual') return 'manual';
  if (kind === 'event') return 'event';
  return 'cron';
}

async function isProviderEnabled(db: Db, cap: string, slug: string): Promise<boolean> {
  const rows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.scope, PROVIDER_ENABLED_SCOPE(cap, slug)))
    .limit(1);
  const v = rows[0]?.value as { enabled?: boolean } | undefined;
  return v?.enabled !== false; // missing row OR { enabled: true } -> enabled
}

async function isAgentEnabled(db: Db, slug: string): Promise<boolean> {
  const rows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.scope, AGENT_ENABLED_SCOPE(slug)))
    .limit(1);
  const v = rows[0]?.value as { enabled?: boolean } | undefined;
  return v?.enabled === true; // missing row OR { enabled: false } -> disabled
}

// -----------------------------------------------------------------------------
// Schemas (kept inline; promotable to api-contract once a second consumer needs them)
// -----------------------------------------------------------------------------

const UpdateAgentSettingsRequest = z.object({
  value: z.unknown(),
});

const CreateConnectorInstanceRequest = z.object({
  capability: z.string().min(1),
  providerSlug: z.string().min(1),
  displayName: z.string().min(1),
  /**
   * Optional one-shot setup. When provided, the framework runs the
   * provider's verify() against this credential payload BEFORE persisting
   * the instance. If verify fails, nothing is written and the operator
   * sees the provider's error. If it succeeds, the instance is created,
   * the credentials saved, settings applied (if any), and isActive set
   * to true — one round-trip from "Add" to "Connected".
   */
  credentials: z.record(z.unknown()).optional(),
  settings: z.unknown().optional(),
});

const UpdateConnectorInstanceRequest = z.object({
  displayName: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  settings: z.unknown().optional(),
});

const SetConnectorCredentialsRequest = z.object({
  /**
   * Free-form connector-defined credential payload. Stored encrypted at rest
   * via SecretsStore.
   */
  credentials: z.unknown(),
});

const TriggerAgentRequest = z.object({
  input: z.unknown().optional(),
});

/**
 * Per-agent connector bindings: which connector instance to use for each
 * capability the agent requires.
 *
 *   { "email": "ae4...uuid", "llm": "be3...uuid" }
 *
 * Validated against the agent's requiredConnectors + existing instances at
 * write time. Missing keys are NOT auto-filled — agents fail loud at run
 * time if a required capability has no binding (deliberate choice; silent
 * fallback to "first connected" hides operator mistakes).
 */
const SetAgentBindingsRequest = z.object({
  bindings: z.record(z.string().uuid()),
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Deterministic Composio "entity" id for a connector instance. Used in both
 * link initiation and active-connection lookup so we don't have to persist
 * extra state between connect and finalize.
 */
function composioUserId(instanceId: string): string {
  return `bos-${instanceId}`;
}

/**
 * Public URL the broker should redirect the operator's browser back to after
 * consent. Composio's hosted callback page will close itself; the UI then
 * polls finalize-connect. For now we redirect back to the settings page —
 * the actual capture happens server-side via getActiveConnection.
 */
function buildCallbackUrl(req: FastifyRequest, _provider: string): string {
  const configured = req.deps.publicUrl;
  if (configured) return `${configured.replace(/\/$/, '')}/connectors`;
  const host = (req.headers['x-forwarded-host'] ?? req.headers.host) as string | undefined;
  const proto = ((req.headers['x-forwarded-proto'] as string) ?? 'http').split(',')[0];
  if (!host) return `http://localhost/connectors`;
  return `${proto}://${host}/connectors`;
}

function require503<T>(thing: T | undefined, reply: FastifyReply, label: string): thing is T {
  if (!thing) {
    reply
      .code(503)
      .send({ error: `${label}_not_wired`, hint: `Provide deps.${label} in buildApp().` });
    return false;
  }
  return true;
}

/**
 * Resolve an external OAuth broker for the given provider. Prefers the lazy
 * DB-sourced getter (when `getExternalOAuthBroker` is wired), then falls back
 * to the static `externalOAuthBrokers` map for backward compat.
 */
async function resolveExternalOAuthBroker(
  deps: {
    getExternalOAuthBroker?: (provider: string) => Promise<ExternalOAuthBrokerLike | null>;
    externalOAuthBrokers?: { composio?: ExternalOAuthBrokerLike };
  },
  provider: string,
): Promise<ExternalOAuthBrokerLike | null> {
  if (deps.getExternalOAuthBroker) {
    return deps.getExternalOAuthBroker(provider);
  }
  // Backward-compat: static broker passed directly to buildApp.
  const staticBroker = deps.externalOAuthBrokers?.[provider as 'composio'];
  return staticBroker ?? null;
}

async function loadAgentSettings(req: FastifyRequest, slug: string): Promise<unknown> {
  const rows = await req.deps.db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.scope, SETTINGS_AGENT_SCOPE(slug)))
    .limit(1);
  return rows[0]?.value ?? null;
}

async function loadAgentBindings(
  db: Db,
  slug: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.scope, SETTINGS_AGENT_BINDINGS_SCOPE(slug)))
    .limit(1);
  const v = rows[0]?.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string>;
  return {};
}

/**
 * Insert-or-update a single settings row. Used by routes that need to
 * persist a per-scope blob (agent settings, bindings, the enable bit).
 * Callers that want fine-grained audit semantics still inline the insert
 * with their own audit message; this helper is the catch-all for system
 * state (enable/disable) where the audit hook fires separately.
 */
async function upsertSetting(
  db: Db,
  scope: string,
  value: unknown,
  updatedBy?: string,
): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ scope, value, updatedBy })
    .onConflictDoUpdate({
      target: settingsTable.scope,
      set: { value, updatedAt: new Date(), updatedBy },
    });
}

async function loadConnectorSettings(
  db: Db,
  capability: string,
  instanceId: string,
): Promise<unknown> {
  const rows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.scope, SETTINGS_CONNECTOR_SCOPE(capability, instanceId)))
    .limit(1);
  return rows[0]?.value ?? null;
}

/**
 * Run the connector's verify() hook against a *proposed* credentials object —
 * without persisting. Used by POST /api/connectors and PUT /credentials so
 * the operator gets a real test before anything is saved.
 *
 * Returns ok=true when verify is missing (Composio paths) or succeeds, ok=
 * false with the provider's error message on failure.
 */
async function runVerify(args: {
  provider: import('../inventory.js').RegisteredConnectorProviderLike;
  proposedCredentials: Record<string, unknown>;
  proposedSettings?: unknown;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const creds: Record<string, unknown> = { ...args.proposedCredentials };
  if (typeof creds.kind !== 'string') creds.kind = args.provider.manifest.authKind;
  // Always validate custom credentials against credentialsSchema, even when
  // the connector has no verify() hook — a typo'd field name should fail at
  // save time, not at first agent run.
  if (creds.kind === 'custom' && args.provider.manifest.credentialsSchema) {
    const parsed = args.provider.manifest.credentialsSchema.safeParse(creds.values ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    }
    creds.values = parsed.data;
  }
  // Settings always validated against the connector's schema. A connector
  // with no verify() hook still benefits from schema-checked settings.
  let settings: unknown;
  {
    const parsed = args.provider.manifest.settingsSchema.safeParse(args.proposedSettings ?? {});
    if (!parsed.success) {
      // Format Zod issues into a human string instead of letting the raw
      // JSON-stringified issues array hit the UI banner.
      return {
        ok: false,
        error: parsed.error.issues
          .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
          .join('; '),
      };
    }
    settings = parsed.data;
  }
  if (!args.provider.verify) return { ok: true };
  try {
    await args.provider.verify({
      credentials: creds,
      settings,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

export function registerAdminRoutes(app: FastifyInstance): void {
  // ---------- GET /api/agents ----------
  app.get('/api/agents', { preHandler: requireUser }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const allAgents = req.deps.inventory.listAgents();
    // Only show installed (DB-enabled) agents on the operator's main list.
    // The Add Agent flow consumes /api/agents/available for the rest.
    const enabledSlugs = new Set<string>();
    for (const a of allAgents) {
      if (await isAgentEnabled(req.deps.db, a.manifest.slug)) enabledSlugs.add(a.manifest.slug);
    }
    const items = await Promise.all(
      allAgents
        .filter((a) => enabledSlugs.has(a.manifest.slug))
        .map(async ({ manifest }) => {
        const settingsValue = await loadAgentSettings(req, manifest.slug);
        const lastRunRows = await req.deps.db
          .select({
            id: agentRuns.id,
            startedAt: agentRuns.startedAt,
            endedAt: agentRuns.endedAt,
            ok: agentRuns.ok,
            summary: agentRuns.summary,
          })
          .from(agentRuns)
          .where(eq(agentRuns.agentSlug, manifest.slug))
          .orderBy(desc(agentRuns.startedAt))
          .limit(1);
        // Effective schedule = operator override (friendly) ?? manifest. Expose
        // it in friendly form + a human label so the list never renders a raw
        // cron expression or the word "cron".
        const override = await loadScheduleOverride(req.deps.db, manifest.slug);
        const effective: FriendlySchedule = override ?? manifest.schedule;
        const effectiveFriendly: FriendlySchedule =
          effective.kind === 'cron' ? cronToFriendly(effective.expr) ?? effective : effective;
        return {
          slug: manifest.slug,
          version: manifest.version,
          displayName: manifest.displayName,
          description: manifest.description,
          requiredConnectors: manifest.requiredConnectors,
          schedule: manifest.schedule,
          effectiveSchedule: effectiveFriendly,
          scheduleDescription: describeSchedule(effectiveFriendly),
          settings: settingsValue,
          /**
           * Surface the input schema (when present) so the Agents list can
           * decide whether the Run-from-list button fires immediately ({} input)
           * or opens an input modal. Null when the agent doesn't declare one.
           */
          inputSchema: manifest.inputSchema
            ? zodToFieldSchema(manifest.inputSchema)
            : null,
          lastRun: lastRunRows[0] ?? null,
        };
      }),
    );
    return { agents: items };
  });

  // ---------- GET /api/agents/:slug ----------
  // ---------- GET /api/agents/available ----------
  // Returns every registered agent that ISN'T installed (no DB enable row).
  // Drives the Add Agent picker — operator sees the catalog of agents this
  // install knows how to run, minus the ones they've already enabled.
  app.get('/api/agents/available', { preHandler: requireUser }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const available = [];
    for (const { manifest } of req.deps.inventory.listAgents()) {
      if (await isAgentEnabled(req.deps.db, manifest.slug)) continue;
      available.push({
        slug: manifest.slug,
        version: manifest.version,
        displayName: manifest.displayName,
        description: manifest.description,
        requiredConnectors: manifest.requiredConnectors,
        schedule: manifest.schedule,
        settingsSchema: zodToFieldSchema(manifest.settingsSchema),
      });
    }
    return { agents: available };
  });

  // ---------- POST /api/agents/:slug/enable ----------
  // Install an agent. Optional body lets the operator seed settings + bindings
  // in the same round-trip so they don't end up with a freshly-enabled agent
  // that's missing connector bindings and can't run.
  app.post('/api/agents/:slug/enable', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const slug = (req.params as { slug: string }).slug;
    let agent;
    try {
      agent = req.deps.inventory.getAgent(slug);
    } catch {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const body = z
      .object({ settings: z.unknown().optional(), bindings: z.record(z.string()).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      reply.code(400).send({ error: 'invalid_input', issues: body.error.issues });
      return;
    }
    // Settings: validate against the agent's schema. Operator may have skipped
    // optional fields — Zod fills defaults. Persist what comes out.
    if (body.data.settings !== undefined) {
      const parsed = agent.manifest.settingsSchema.safeParse(body.data.settings);
      if (!parsed.success) {
        reply.code(400).send({ error: 'invalid_settings', issues: parsed.error.issues });
        return;
      }
      await upsertSetting(req.deps.db, SETTINGS_AGENT_SCOPE(slug), parsed.data);
    }
    if (body.data.bindings) {
      // Strip empty strings — operator left a capability unset; we don't want
      // to send "" through and trip the uuid validator on the bindings route.
      const clean = Object.fromEntries(
        Object.entries(body.data.bindings).filter(([, v]) => v && v.length > 0),
      );
      await upsertSetting(req.deps.db, SETTINGS_AGENT_BINDINGS_SCOPE(slug), clean);
    }
    await upsertSetting(req.deps.db, AGENT_ENABLED_SCOPE(slug), { enabled: true });
    await req.audit('admin.agent.enabled', { slug });
    const trigger = req.deps.trigger as { refreshAgent?: (slug: string) => Promise<void> } | undefined;
    if (trigger?.refreshAgent) await trigger.refreshAgent(slug).catch(() => {});
    await notifyAgentRefresh(req.deps.db, slug);
    return { ok: true };
  });

  // ---------- POST /api/agents/:slug/disable ----------
  // Uninstall an agent. Preserves runs, settings, bindings, schedule — so
  // re-enabling later doesn't lose history. A scheduler watching this scope
  // should stop firing the agent on cron / event triggers.
  app.post('/api/agents/:slug/disable', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const slug = (req.params as { slug: string }).slug;
    try {
      req.deps.inventory.getAgent(slug);
    } catch {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    await upsertSetting(req.deps.db, AGENT_ENABLED_SCOPE(slug), { enabled: false });
    await req.audit('admin.agent.disabled', { slug });
    const trigger = req.deps.trigger as { refreshAgent?: (slug: string) => Promise<void> } | undefined;
    if (trigger?.refreshAgent) await trigger.refreshAgent(slug).catch(() => {});
    await notifyAgentRefresh(req.deps.db, slug);
    return { ok: true };
  });

  app.get('/api/agents/:slug', { preHandler: requireUser }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const slug = (req.params as { slug: string }).slug;
    let agent;
    try {
      agent = req.deps.inventory.getAgent(slug);
    } catch {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const settingsValue = await loadAgentSettings(req, slug);
    const bindings = await loadAgentBindings(req.deps.db, slug);
    const lastRunRows = await req.deps.db
      .select({
        id: agentRuns.id,
        startedAt: agentRuns.startedAt,
        endedAt: agentRuns.endedAt,
        ok: agentRuns.ok,
        summary: agentRuns.summary,
      })
      .from(agentRuns)
      .where(eq(agentRuns.agentSlug, slug))
      .orderBy(desc(agentRuns.startedAt))
      .limit(1);
    return {
      slug: agent.manifest.slug,
      version: agent.manifest.version,
      displayName: agent.manifest.displayName,
      description: agent.manifest.description,
      requiredConnectors: agent.manifest.requiredConnectors,
      schedule: agent.manifest.schedule,
      settings: settingsValue,
      connectorBindings: bindings,
      settingsSchema: zodToFieldSchema(agent.manifest.settingsSchema),
      inputSchema: agent.manifest.inputSchema
        ? zodToFieldSchema(agent.manifest.inputSchema)
        : null,
      lastRun: lastRunRows[0] ?? null,
    };
  });

  // ---------- GET /api/agents/:slug/schedule ----------
  // Returns the operator's schedule override (null when not set) and the
  // effective schedule that drives the runtime (override ?? manifest).
  // Also lists which trigger kinds the agent supports so the UI can render
  // only the legal radio options, plus the event topics any bound connector
  // can emit so the UI populates the event-mode dropdown from real options.
  app.get('/api/agents/:slug/schedule', { preHandler: requireUser }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const slug = (req.params as { slug: string }).slug;
    let agent;
    try {
      agent = req.deps.inventory.getAgent(slug);
    } catch {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const override = await loadScheduleOverride(req.deps.db, slug);
    const effective = override ?? agent.manifest.schedule;
    const supportedTriggers =
      agent.manifest.supportedTriggers ?? [
        agent.manifest.schedule.kind,
        // Manual is always allowed even if the manifest didn't list it —
        // operators can always click "Run now" regardless.
        'manual' as const,
      ];
    // Collect available event topics from each bound connector instance's
    // provider manifest. Gives the UI a real dropdown for event-mode instead
    // of a free-text field.
    const bindings = await loadAgentBindings(req.deps.db, slug);
    const availableEventTopics: Array<{ topic: string; displayName: string; via: string }> = [];
    for (const [capability, instanceId] of Object.entries(bindings)) {
      // Bindings can be stale (e.g. leftover from earlier curl-based testing)
      // or hold non-uuid placeholders. Swallow lookup errors — schedule UI
      // shouldn't 500 just because one binding is junk.
      let row: { id: string; providerSlug: string } | undefined;
      try {
        const rows = await req.deps.db
          .select({ id: connectorInstances.id, providerSlug: connectorInstances.providerSlug })
          .from(connectorInstances)
          .where(eq(connectorInstances.id, instanceId))
          .limit(1);
        row = rows[0];
      } catch {
        continue;
      }
      if (!row) continue;
      let provider;
      try {
        provider = req.deps.inventory.getConnectorProvider(capability, row.providerSlug);
      } catch {
        continue;
      }
      const events = (provider.manifest as { events?: Record<string, { displayName: string }> }).events;
      if (!events) continue;
      for (const [topic, def] of Object.entries(events)) {
        availableEventTopics.push({ topic, displayName: def.displayName, via: row.providerSlug });
      }
    }
    // Translate everything to the friendly representation for the UI. A
    // manifest may declare a raw cron expr (`{kind:'cron',expr}`); surface it as
    // its recognised friendly kind when possible so the UI shows friendly
    // controls, falling back to the cron escape hatch otherwise.
    const toFriendly = (s: FriendlySchedule): FriendlySchedule =>
      s.kind === 'cron' ? cronToFriendly(s.expr) ?? s : s;
    const manifestFriendly = toFriendly(agent.manifest.schedule);
    const overrideFriendly = override ? toFriendly(override) : null;
    const effectiveFriendly = toFriendly(effective);
    const next = nextRun(effectiveFriendly);
    return {
      manifest: manifestFriendly,
      override: overrideFriendly,
      effective: effectiveFriendly,
      description: describeSchedule(effectiveFriendly),
      nextRunAt: next ? next.toISOString() : null,
      supportedTriggers: Array.from(new Set(supportedTriggers)),
      availableEventTopics,
    };
  });

  // ---------- PUT /api/agents/:slug/schedule ----------
  // Set or clear the override. Body is a discriminated union: omit to
  // clear (revert to manifest), or send a `{kind: ...}` object to override.
  app.put('/api/agents/:slug/schedule', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const slug = (req.params as { slug: string }).slug;
    let agent;
    try {
      agent = req.deps.inventory.getAgent(slug);
    } catch {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const body = z
      .object({
        override: ScheduleOverrideSchema.nullable(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      reply.code(400).send({ error: 'invalid_input', issues: body.error.issues });
      return;
    }
    const next = body.data.override;
    if (next) {
      // Gate against supportedTriggers — operator can't pick a kind the
      // agent's author didn't list. The friendly time-based kinds (interval /
      // daily / weekly) and the cron escape hatch all map to the 'cron' trigger.
      const supported =
        agent.manifest.supportedTriggers ?? [agent.manifest.schedule.kind, 'manual' as const];
      const triggerKind = triggerKindOf(next.kind);
      if (!supported.includes(triggerKind)) {
        reply.code(400).send({
          error: 'unsupported_trigger',
          message: `agent doesn't support trigger kind "${triggerKind}"`,
        });
        return;
      }
      await upsertSetting(req.deps.db, AGENT_SCHEDULE_SCOPE(slug), next, req.user!.id);
    } else {
      // Clear the override row entirely.
      await req.deps.db
        .delete(settingsTable)
        .where(eq(settingsTable.scope, AGENT_SCHEDULE_SCOPE(slug)));
    }
    await req.audit('admin.agent.schedule.update', { slug, override: next });
    // Best-effort: tell the in-process scheduler to re-read the override.
    // If the trigger backend doesn't expose `refreshAgent`, the change takes
    // effect on next restart — still functional, just less immediate.
    const trigger = req.deps.trigger as { refreshAgent?: (slug: string) => Promise<void> } | undefined;
    if (trigger?.refreshAgent) {
      await trigger.refreshAgent(slug).catch(() => {
        /* refresh is best-effort; the override is persisted regardless */
      });
    }
    await notifyAgentRefresh(req.deps.db, slug);
    return { ok: true as const, override: next };
  });

  // ---------- PUT /api/agents/:slug/bindings ----------
  app.put('/api/agents/:slug/bindings', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const slug = (req.params as { slug: string }).slug;
    let agent;
    try {
      agent = req.deps.inventory.getAgent(slug);
    } catch {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const body = SetAgentBindingsRequest.safeParse(req.body);
    if (!body.success) {
      reply.code(400).send({ error: 'invalid_input' });
      return;
    }

    // Reject capabilities the agent doesn't actually need — keeps bindings
    // tight to the manifest and prevents accidental misbindings.
    const required = new Set(agent.manifest.requiredConnectors);
    for (const cap of Object.keys(body.data.bindings)) {
      if (!required.has(cap)) {
        reply.code(400).send({
          error: 'capability_not_required_by_agent',
          capability: cap,
        });
        return;
      }
    }

    // Verify every referenced instance exists and matches the declared
    // capability. Avoids silently binding to a deleted or mismatched instance.
    for (const [cap, instanceId] of Object.entries(body.data.bindings)) {
      const rows = await req.deps.db
        .select({ id: connectorInstances.id, capability: connectorInstances.capability })
        .from(connectorInstances)
        .where(eq(connectorInstances.id, instanceId))
        .limit(1);
      const inst = rows[0];
      if (!inst) {
        reply.code(400).send({
          error: 'connector_instance_not_found',
          capability: cap,
          instanceId,
        });
        return;
      }
      if (inst.capability !== cap) {
        reply.code(400).send({
          error: 'instance_capability_mismatch',
          capability: cap,
          instanceCapability: inst.capability,
        });
        return;
      }
    }

    await req.deps.db
      .insert(settingsTable)
      .values({
        scope: SETTINGS_AGENT_BINDINGS_SCOPE(slug),
        value: body.data.bindings,
        updatedBy: req.user!.id,
      })
      .onConflictDoUpdate({
        target: settingsTable.scope,
        set: {
          value: body.data.bindings,
          updatedAt: new Date(),
          updatedBy: req.user!.id,
        },
      });
    await req.audit('admin.agent.bindings.update', { slug, bindings: body.data.bindings });
    return { ok: true as const, bindings: body.data.bindings };
  });

  // ---------- PUT /api/agents/:slug/settings ----------
  app.put('/api/agents/:slug/settings', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const slug = (req.params as { slug: string }).slug;
    let agent;
    try {
      agent = req.deps.inventory.getAgent(slug);
    } catch {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const body = UpdateAgentSettingsRequest.safeParse(req.body);
    if (!body.success) {
      reply.code(400).send({ error: 'invalid_input' });
      return;
    }
    const parsed = agent.manifest.settingsSchema.safeParse(body.data.value);
    if (!parsed.success) {
      reply.code(400).send({
        error: 'settings_schema_violation',
        issues: parsed.error.issues,
      });
      return;
    }
    await req.deps.db
      .insert(settingsTable)
      .values({
        scope: SETTINGS_AGENT_SCOPE(slug),
        value: parsed.data,
        updatedBy: req.user!.id,
      })
      .onConflictDoUpdate({
        target: settingsTable.scope,
        set: {
          value: parsed.data,
          updatedAt: new Date(),
          updatedBy: req.user!.id,
        },
      });
    await req.audit('admin.agent.settings.update', { slug });
    return { ok: true as const, settings: parsed.data };
  });

  // ---------- POST /api/agents/:slug/run ----------
  app.post('/api/agents/:slug/run', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    if (!require503(req.deps.trigger, reply, 'trigger')) return;
    const slug = (req.params as { slug: string }).slug;
    try {
      req.deps.inventory.getAgent(slug);
    } catch {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const body = TriggerAgentRequest.safeParse(req.body ?? {});
    if (!body.success) {
      reply.code(400).send({ error: 'invalid_input' });
      return;
    }
    await req.deps.trigger.triggerManual(slug, body.data.input, req.user!.id);
    await req.audit('admin.agent.run.manual', { slug });
    return { ok: true as const };
  });

  // ---------- GET /api/agents/:slug/runs ----------
  app.get('/api/agents/:slug/runs', { preHandler: requireUser }, async (req) => {
    const slug = (req.params as { slug: string }).slug;
    const limit = Math.min(
      Number((req.query as { limit?: string }).limit ?? 50),
      200,
    );
    const q = req.query as { before?: string };
    const filters: SQL[] = [eq(agentRuns.agentSlug, slug)];
    if (q.before) {
      const t = new Date(q.before);
      if (!Number.isNaN(t.getTime())) filters.push(lt(agentRuns.startedAt, t));
    }
    const rows = await req.deps.db
      .select({
        id: agentRuns.id,
        startedAt: agentRuns.startedAt,
        endedAt: agentRuns.endedAt,
        ok: agentRuns.ok,
        summary: agentRuns.summary,
        trigger: agentRuns.trigger,
        triggeredBy: agentRuns.triggeredBy,
      })
      .from(agentRuns)
      .where(and(...filters))
      .orderBy(desc(agentRuns.startedAt))
      .limit(limit);
    const nextBefore =
      rows.length === limit && rows[rows.length - 1]
        ? rows[rows.length - 1]!.startedAt.toISOString()
        : null;
    return { runs: rows, nextBefore };
  });

  // ---------- GET /api/runs/:id ----------
  // Single run + correlated audit log. The runtime sets requestId=runId when
  // building the AuditContext, so the audit_log.request_id column is the join
  // key.
  app.get('/api/runs/:id', { preHandler: requireUser }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rows = await req.deps.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, id))
      .limit(1);
    const run = rows[0];
    if (!run) {
      reply.code(404).send({ error: 'run_not_found' });
      return;
    }
    const audits = await req.deps.db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        action: auditLog.action,
        userId: auditLog.userId,
        agentSlug: auditLog.agentSlug,
        meta: auditLog.meta,
      })
      .from(auditLog)
      .where(eq(auditLog.requestId, id))
      .orderBy(auditLog.at);
    return { run, audits };
  });

  // ---------- GET /api/connectors ----------
  app.get('/api/connectors', { preHandler: requireUser }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    // Tell the browser never to cache this — connector state changes
    // mid-session (Save & test, Disconnect, Update key) and operators
    // were seeing stale "not connected" after a fresh add until they
    // hard-refreshed.
    reply.header('cache-control', 'no-store');
    // Build the capability → providers map from the registry, then attach the
    // operator-configured instances per capability.
    const caps = new Set<string>();
    // Walk known capabilities — the registry doesn't expose `listCapabilities`,
    // so we drain the type-registry by probing each known key. New capabilities
    // added to ConnectorCapabilityMap need adding here too.
    for (const cap of ['email', 'email-inbox', 'crm', 'llm', 'file-storage']) caps.add(cap);

    const instances = await req.deps.db
      .select()
      .from(connectorInstances)
      .orderBy(desc(connectorInstances.createdAt));

    const result = await Promise.all(
      [...caps].map(async (capability) => {
        const allProviders = req.deps.inventory!.listConnectorProviders(capability);
        // Filter by operator's enable/disable choice. Disabled providers are
        // still registered (so existing instances keep working) but hidden
        // from the Add Instance dropdown.
        const providers = await Promise.all(
          allProviders.map(async (p) => {
            const enabled = await isProviderEnabled(req.deps.db, capability, p.manifest.slug);
            return {
              slug: p.manifest.slug,
              displayName: p.manifest.displayName,
              authKind: p.manifest.authKind,
              externalOAuth: p.manifest.externalOAuth,
              version: p.manifest.version,
              settingsSchema: zodToFieldSchema(p.manifest.settingsSchema),
              ...(p.manifest.credentialsSchema
                ? { credentialsSchema: zodToFieldSchema(p.manifest.credentialsSchema) }
                : {}),
              enabled,
            };
          }),
        ).then((arr) => arr.filter((p) => p.enabled));
        const capInstances = await Promise.all(
          instances
            .filter((i) => i.capability === capability)
            .map(async (i) => {
              const settingsValue = await loadConnectorSettings(req.deps.db, capability, i.id);
              const credsScope = SECRETS_CONNECTOR_SCOPE(capability, i.id);
              const credBytes = await req.deps.secrets.get(credsScope, CREDENTIAL_KEY);
              return {
                id: i.id,
                providerSlug: i.providerSlug,
                displayName: i.displayName,
                isActive: i.isActive,
                createdAt: i.createdAt,
                settings: settingsValue,
                /**
                 * True iff the operator has saved credentials. The UI uses
                 * this to know which action to surface — "Set key" vs
                 * "Test connection" vs "Update key".
                 */
                hasCredentials: !!credBytes,
              };
            }),
        );
        return { capability, providers, instances: capInstances };
      }),
    );
    return { capabilities: result };
  });

  // ---------- POST /api/connectors ----------
  // One-shot: validate provider exists → if credentials provided, run
  // verify() FIRST (no persisting on failure) → insert instance →
  // save creds + settings → flip isActive=true. Anything that fails
  // partway leaves the operator with no half-broken row to clean up.
  app.post('/api/connectors', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const body = CreateConnectorInstanceRequest.safeParse(req.body);
    if (!body.success) {
      reply.code(400).send({ error: 'invalid_input' });
      return;
    }
    let provider;
    try {
      provider = req.deps.inventory.getConnectorProvider(
        body.data.capability,
        body.data.providerSlug,
      );
    } catch {
      reply.code(400).send({ error: 'unknown_provider' });
      return;
    }

    // If creds supplied, test them BEFORE inserting the row so a failed
    // setup doesn't leave a stub instance behind.
    if (body.data.credentials) {
      const verifyResult = await runVerify({
        provider,
        proposedCredentials: body.data.credentials as Record<string, unknown>,
        proposedSettings: body.data.settings,
      });
      if (!verifyResult.ok) {
        await req.audit('admin.connector.create.verify_failed', {
          capability: body.data.capability,
          providerSlug: body.data.providerSlug,
          error: verifyResult.error,
        });
        return reply.code(400).send({ error: 'verify_failed', message: verifyResult.error });
      }
    }

    const rows = await req.deps.db
      .insert(connectorInstances)
      .values({
        capability: body.data.capability,
        providerSlug: body.data.providerSlug,
        displayName: body.data.displayName,
        isActive: !!body.data.credentials, // active iff creds were tested+saved here
      })
      .returning();
    const instance = rows[0]!;

    if (body.data.credentials) {
      const creds: Record<string, unknown> = { ...(body.data.credentials as Record<string, unknown>) };
      if (typeof creds.kind !== 'string') creds.kind = provider.manifest.authKind;
      await req.deps.secrets.put(
        SECRETS_CONNECTOR_SCOPE(body.data.capability, instance.id),
        CREDENTIAL_KEY,
        JSON.stringify(creds),
      );
    }
    if (body.data.settings !== undefined) {
      await req.deps.db
        .insert(settingsTable)
        .values({
          scope: SETTINGS_CONNECTOR_SCOPE(body.data.capability, instance.id),
          value: body.data.settings,
        })
        .onConflictDoUpdate({
          target: settingsTable.scope,
          set: { value: body.data.settings, updatedAt: new Date() },
        });
    }

    await req.audit('admin.connector.create', {
      capability: body.data.capability,
      providerSlug: body.data.providerSlug,
      activated: !!body.data.credentials,
    });
    return { instance };
  });

  // ---------- PATCH /api/connectors/:id ----------
  app.patch('/api/connectors/:id', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const id = (req.params as { id: string }).id;
    const body = UpdateConnectorInstanceRequest.safeParse(req.body);
    if (!body.success) {
      reply.code(400).send({ error: 'invalid_input' });
      return;
    }

    const existingRows = await req.deps.db
      .select()
      .from(connectorInstances)
      .where(eq(connectorInstances.id, id))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      reply.code(404).send({ error: 'connector_instance_not_found' });
      return;
    }

    // Validate settings against the provider's manifest if provided.
    if (body.data.settings !== undefined) {
      let provider;
      try {
        provider = req.deps.inventory.getConnectorProvider(
          existing.capability,
          existing.providerSlug,
        );
      } catch {
        reply.code(409).send({ error: 'provider_not_registered_anymore' });
        return;
      }
      const parsed = provider.manifest.settingsSchema.safeParse(body.data.settings);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'settings_schema_violation',
          issues: parsed.error.issues,
        });
        return;
      }
      const scope = SETTINGS_CONNECTOR_SCOPE(existing.capability, existing.id);
      await req.deps.db
        .insert(settingsTable)
        .values({ scope, value: parsed.data, updatedBy: req.user!.id })
        .onConflictDoUpdate({
          target: settingsTable.scope,
          set: {
            value: parsed.data,
            updatedAt: new Date(),
            updatedBy: req.user!.id,
          },
        });
    }

    // NOTE: previously this branch deactivated all other instances of the
    // same capability when activating one (one-active-per-capability model).
    // That restriction was removed when per-agent connector bindings landed:
    // multiple Gmail / Outlook / IMAP instances can now coexist, all marked
    // active, and each agent picks which one it uses via its bindings.
    // `isActive` semantically now means "this instance is connected and
    // available for an agent to bind to"; the name is left as-is to avoid
    // a wider rename. See agent-bindings flow in this same file.

    const updates: Partial<typeof connectorInstances.$inferInsert> = {};
    if (body.data.displayName !== undefined) updates.displayName = body.data.displayName;
    if (body.data.isActive !== undefined) updates.isActive = body.data.isActive;
    if (Object.keys(updates).length > 0) {
      await req.deps.db
        .update(connectorInstances)
        .set(updates)
        .where(eq(connectorInstances.id, id));
    }
    await req.audit('admin.connector.update', { id, ...body.data });

    const after = await req.deps.db
      .select()
      .from(connectorInstances)
      .where(eq(connectorInstances.id, id))
      .limit(1);
    return { instance: after[0] };
  });

  // ---------- PUT /api/connectors/:id/credentials ----------
  // Always tests new credentials against the provider's verify() hook
  // BEFORE persisting. On test failure, nothing is written — the existing
  // (working) credentials stay in place. On success, the new creds replace
  // the old and the instance stays active.
  app.put('/api/connectors/:id/credentials', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const id = (req.params as { id: string }).id;
    const body = SetConnectorCredentialsRequest.safeParse(req.body);
    if (!body.success) {
      reply.code(400).send({ error: 'invalid_input' });
      return;
    }
    const existing = await req.deps.db
      .select()
      .from(connectorInstances)
      .where(eq(connectorInstances.id, id))
      .limit(1);
    if (!existing[0]) {
      reply.code(404).send({ error: 'connector_instance_not_found' });
      return;
    }
    const inst = existing[0];
    const provider = req.deps.inventory.getConnectorProvider(inst.capability, inst.providerSlug);

    const verifyResult = await runVerify({
      provider,
      proposedCredentials: body.data.credentials as Record<string, unknown>,
      proposedSettings: await loadConnectorSettings(req.deps.db, inst.capability, id),
    });
    if (!verifyResult.ok) {
      await req.audit('admin.connector.credentials.verify_failed', { id, error: verifyResult.error });
      return reply.code(400).send({ error: 'verify_failed', message: verifyResult.error });
    }

    const scope = SECRETS_CONNECTOR_SCOPE(inst.capability, id);
    const creds: Record<string, unknown> = { ...(body.data.credentials as Record<string, unknown>) };
    if (typeof creds.kind !== 'string') creds.kind = provider.manifest.authKind;
    await req.deps.secrets.put(scope, CREDENTIAL_KEY, JSON.stringify(creds));
    // Update with new key should leave the instance active.
    await req.deps.db
      .update(connectorInstances)
      .set({ isActive: true })
      .where(eq(connectorInstances.id, id));
    await req.audit('admin.connector.credentials.update', { id });
    return { ok: true as const };
  });

  // ---------- POST /api/connectors/:id/connect ----------
  //
  // Initiates an external-OAuth flow (Composio-driven for now). Returns a
  // redirect URL the operator's browser visits to grant access. After the
  // operator returns, the UI calls finalize-connect (below) to persist the
  // resulting credential.
  //
  // The composio user_id is deterministic (`bos-<instanceId>`) — no
  // intermediate state to store between connect and finalize.
  app.post('/api/connectors/:id/connect', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const id = (req.params as { id: string }).id;

    const rows = await req.deps.db
      .select()
      .from(connectorInstances)
      .where(eq(connectorInstances.id, id))
      .limit(1);
    const instance = rows[0];
    if (!instance) {
      reply.code(404).send({ error: 'connector_instance_not_found' });
      return;
    }

    let provider;
    try {
      provider = req.deps.inventory.getConnectorProvider(
        instance.capability,
        instance.providerSlug,
      );
    } catch {
      reply.code(409).send({ error: 'provider_not_registered_anymore' });
      return;
    }
    const ext = provider.manifest.externalOAuth;
    if (!ext) {
      reply.code(400).send({ error: 'connector_does_not_use_external_oauth' });
      return;
    }
    const broker = await resolveExternalOAuthBroker(req.deps, ext.provider);
    if (!broker) {
      reply.code(503).send({
        error: 'external_oauth_broker_not_wired',
        hint: `Configure the ${ext.provider} API key via the operator settings UI, or pass externalOAuthBrokers.${ext.provider} to startServer().`,
      });
      return;
    }

    const callbackUrl = buildCallbackUrl(req, ext.provider);
    const authConfig = await broker.findOrCreateManagedAuthConfig(ext.toolkit);
    const link = await broker.createConnectionLink({
      userId: composioUserId(instance.id),
      authConfigId: authConfig.id,
      callbackUrl,
    });
    await req.audit('admin.connector.connect.initiate', {
      id,
      provider: ext.provider,
      toolkit: ext.toolkit,
    });
    return { redirectUrl: link.redirectUrl };
  });

  // ---------- POST /api/connectors/:id/finalize-connect ----------
  //
  // Polled by the UI after the operator returns from the consent screen.
  // Asks the broker whether the connection is now ACTIVE. If yes, persists
  // the credential (broker API key + per-instance user_id + connected
  // account id) and marks the instance active. If no, returns { pending: true }.
  app.post(
    '/api/connectors/:id/finalize-connect',
    { preHandler: [requireUser, requireRole('admin')] },
    async (req, reply) => {
      if (!require503(req.deps.inventory, reply, 'inventory')) return;
      const id = (req.params as { id: string }).id;

      const rows = await req.deps.db
        .select()
        .from(connectorInstances)
        .where(eq(connectorInstances.id, id))
        .limit(1);
      const instance = rows[0];
      if (!instance) {
        reply.code(404).send({ error: 'connector_instance_not_found' });
        return;
      }

      let provider;
      try {
        provider = req.deps.inventory.getConnectorProvider(
          instance.capability,
          instance.providerSlug,
        );
      } catch {
        reply.code(409).send({ error: 'provider_not_registered_anymore' });
        return;
      }
      const ext = provider.manifest.externalOAuth;
      if (!ext) {
        reply.code(400).send({ error: 'connector_does_not_use_external_oauth' });
        return;
      }
      const broker = await resolveExternalOAuthBroker(req.deps, ext.provider);
      if (!broker) {
        reply.code(503).send({
          error: 'external_oauth_broker_not_wired',
          hint: 'Configure the Composio API key via Settings → Platform Integrations, or pass externalOAuthBrokers.composio to startServer().',
        });
        return;
      }

      const userId = composioUserId(instance.id);
      const connectedAccountId = await broker.getActiveConnection(userId, ext.toolkit);
      if (!connectedAccountId) {
        return { pending: true as const };
      }

      // Persist credentials in the shape Composio-backed connectors expect:
      // kind=api-key, key=<composio API key>, extra=per-instance handles.
      // The API key is read from the DB secrets store first (operator-configured
      // via the settings UI), then falls back to the env var for backward compat
      // with existing deploys that set COMPOSIO_API_KEY in their .env.
      const brokerApiKey =
        (await req.deps.secrets.get(`platform:${ext.provider}`, 'api_key')) ??
        process.env[`${ext.provider.toUpperCase()}_API_KEY`];
      if (!brokerApiKey) {
        reply.code(503).send({
          error: 'broker_api_key_not_configured',
          hint: `Configure the ${ext.provider} API key via the operator settings UI (Platform Integrations section), or set ${ext.provider.toUpperCase()}_API_KEY in the environment.`,
        });
        return;
      }
      const credentialPayload = {
        kind: 'api-key' as const,
        key: brokerApiKey,
        extra: { userId, connectedAccountId },
      };
      const scope = SECRETS_CONNECTOR_SCOPE(instance.capability, id);
      await req.deps.secrets.put(scope, CREDENTIAL_KEY, JSON.stringify(credentialPayload));

      // Mark this instance active. We no longer deactivate siblings — multiple
      // instances per capability can coexist, agents bind to specific ones.
      await req.deps.db
        .update(connectorInstances)
        .set({ isActive: true })
        .where(eq(connectorInstances.id, id));

      await req.audit('admin.connector.connect.finalize', {
        id,
        provider: ext.provider,
        toolkit: ext.toolkit,
      });
      return { ok: true as const, connectedAccountId };
    },
  );

  // ---------- POST /api/connectors/:id/test ----------
  //
  // Calls the connector package's optional `verify(ctx)` hook with the saved
  // credentials + settings. Used by the UI's "Test connection" button.
  // verify() implementations hit the cheapest auth-required endpoint the
  // provider exposes (Anthropic + OpenAI list models; Composio-backed
  // connectors get this for free via the Connect flow). NO billable tokens.
  //
  // On success, returns { ok: true } and the UI flips the instance to active.
  // On failure, returns { ok: false, error: <message> } — UI shows it inline.
  app.post('/api/connectors/:id/test', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    const id = (req.params as { id: string }).id;
    const existing = await req.deps.db
      .select()
      .from(connectorInstances)
      .where(eq(connectorInstances.id, id))
      .limit(1);
    if (!existing[0]) {
      reply.code(404).send({ error: 'connector_instance_not_found' });
      return;
    }
    const inst = existing[0];

    const provider = req.deps.inventory.getConnectorProvider(
      inst.capability,
      inst.providerSlug,
    );
    if (!provider.verify) {
      // No verify hook — nothing to test. Treat as success so Composio-backed
      // connectors don't get stuck behind a missing button.
      return { ok: true as const, message: 'no test available for this connector' };
    }

    // Pull credentials + parsed settings into the ctx the connector expects.
    const scope = SECRETS_CONNECTOR_SCOPE(inst.capability, id);
    const rawCreds = await req.deps.secrets.get(scope, CREDENTIAL_KEY);
    if (!rawCreds) {
      return { ok: false as const, error: 'No credentials saved yet — save the key first.' };
    }
    let credentials: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawCreds.toString());
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      credentials = parsed as Record<string, unknown>;
    } catch {
      return { ok: false as const, error: 'Saved credentials are unreadable.' };
    }
    // Operator-set credentials are sometimes saved without a `kind` field
    // (the UI used to PUT `{ key }` directly). Backfill from the manifest's
    // authKind so connectors that strictly check `credentials.kind` don't
    // see undefined.
    if (typeof credentials.kind !== 'string') {
      credentials.kind = provider.manifest.authKind;
    }
    const rawSettings = await loadConnectorSettings(req.deps.db, inst.capability, id);
    const settings = provider.manifest.settingsSchema.parse(rawSettings ?? {});

    try {
      await provider.verify({
        credentials: credentials as never,
        settings: settings as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      await req.audit('admin.connector.test.ok', { id, providerSlug: inst.providerSlug });
      return { ok: true as const };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await req.audit('admin.connector.test.failed', { id, providerSlug: inst.providerSlug, error: message });
      return { ok: false as const, error: message };
    }
  });

  // ---------- DELETE /api/connectors/:id ----------
  app.delete('/api/connectors/:id', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = await req.deps.db
      .select()
      .from(connectorInstances)
      .where(eq(connectorInstances.id, id))
      .limit(1);
    if (!existing[0]) {
      reply.code(404).send({ error: 'connector_instance_not_found' });
      return;
    }
    // Cascade: remove settings + secrets for this instance scope.
    const scope = SECRETS_CONNECTOR_SCOPE(existing[0].capability, id);
    await req.deps.db.delete(settingsTable).where(eq(settingsTable.scope, scope));
    const secretKeys = await req.deps.secrets.listScope(scope);
    for (const k of secretKeys) await req.deps.secrets.delete(scope, k);
    await req.deps.db.delete(connectorInstances).where(eq(connectorInstances.id, id));
    await req.audit('admin.connector.delete', { id });
    return { ok: true as const };
  });

  // ---------- GET /api/providers ----------
  // List every framework-registered connector provider with its current
  // enable/disable state. Powers the Providers admin page. The Connectors
  // page filters by enabled (above); this page surfaces them all.
  app.get('/api/providers', { preHandler: requireUser }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    reply.header('cache-control', 'no-store');

    const caps = ['email', 'email-inbox', 'crm', 'llm', 'file-storage'];
    const groups = await Promise.all(
      caps.map(async (capability) => {
        const providers = await Promise.all(
          req.deps.inventory!.listConnectorProviders(capability).map(async (p) => ({
            slug: p.manifest.slug,
            displayName: p.manifest.displayName,
            authKind: p.manifest.authKind,
            externalOAuth: p.manifest.externalOAuth,
            version: p.manifest.version,
            enabled: await isProviderEnabled(req.deps.db, capability, p.manifest.slug),
          })),
        );
        return { capability, providers };
      }),
    );
    return { capabilities: groups };
  });

  // ---------- PUT /api/providers/:capability/:slug ----------
  // Toggle a single provider's enabled state. Disabling does NOT delete
  // existing instances of that provider — operator does that explicitly
  // from the Connectors page. The instances keep working at runtime; they
  // just don't get new siblings until the provider is re-enabled.
  app.put(
    '/api/providers/:capability/:slug',
    { preHandler: [requireUser, requireRole('admin')] },
    async (req, reply) => {
      if (!require503(req.deps.inventory, reply, 'inventory')) return;
      const { capability, slug } = req.params as { capability: string; slug: string };
      const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!body.success) {
        reply.code(400).send({ error: 'invalid_input' });
        return;
      }
      // Refuse to operate on unknown providers — keeps the settings table
      // from accruing orphan rows for packages that aren't registered.
      try {
        req.deps.inventory.getConnectorProvider(capability, slug);
      } catch {
        reply.code(404).send({ error: 'unknown_provider' });
        return;
      }
      const scope = PROVIDER_ENABLED_SCOPE(capability, slug);
      await req.deps.db
        .insert(settingsTable)
        .values({ scope, value: { enabled: body.data.enabled } })
        .onConflictDoUpdate({
          target: settingsTable.scope,
          set: { value: { enabled: body.data.enabled }, updatedAt: new Date() },
        });
      await req.audit('admin.provider.enabled.update', {
        capability,
        slug,
        enabled: body.data.enabled,
      });
      return { ok: true as const, enabled: body.data.enabled };
    },
  );

  // ---------- GET /api/modules ----------
  // List registered modules so the UI can render their pages + nav entries.
  app.get('/api/modules', { preHandler: requireUser }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;
    if (!req.deps.inventory.listModules) {
      return { modules: [] };
    }
    const out = await Promise.all(
      req.deps.inventory.listModules().map(async (mod) => {
        const scope = `module:${mod.manifest.slug}`;
        const rows = await req.deps.db
          .select({ value: settingsTable.value })
          .from(settingsTable)
          .where(eq(settingsTable.scope, scope))
          .limit(1);
        return {
          slug: mod.manifest.slug,
          version: mod.manifest.version,
          displayName: mod.manifest.displayName,
          description: mod.manifest.description,
          // `defaultAudience` + per-page `audience` drive the UI's nav-gating
          // and route guard (AudienceTag enforcement). Passed through as-is;
          // the UI treats anything other than {kind:'admins'} as everyone.
          defaultAudience: normalizeAudience(mod.manifest.defaultAudience),
          uiPages:
            mod.uiPages?.map((p) => ({
              path: p.path,
              navLabel: p.navLabel,
              audience: normalizeAudience(p.audience),
            })) ?? [],
          settings: rows[0]?.value ?? null,
          settingsSchema: zodToFieldSchema(
            mod.manifest.settingsSchema as Parameters<typeof zodToFieldSchema>[0],
          ),
        };
      }),
    );
    return { modules: out };
  });

  // ---------- PUT /api/modules/:slug/settings ----------
  app.put(
    '/api/modules/:slug/settings',
    { preHandler: [requireUser, requireRole('admin')] },
    async (req, reply) => {
      if (!require503(req.deps.inventory, reply, 'inventory')) return;
      if (!req.deps.inventory.listModules || !req.deps.inventory.getModule) {
        reply.code(503).send({ error: 'modules_not_wired' });
        return;
      }
      const slug = (req.params as { slug: string }).slug;
      let mod;
      try {
        mod = req.deps.inventory.getModule(slug);
      } catch {
        reply.code(404).send({ error: 'module_not_found' });
        return;
      }
      const body = req.body as { value?: unknown };
      const parsed = (mod.manifest.settingsSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown } } }).safeParse(body?.value);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'settings_schema_violation',
          issues: parsed.error?.issues,
        });
        return;
      }
      const scope = `module:${slug}`;
      await req.deps.db
        .insert(settingsTable)
        .values({ scope, value: parsed.data, updatedBy: req.user!.id })
        .onConflictDoUpdate({
          target: settingsTable.scope,
          set: {
            value: parsed.data,
            updatedAt: new Date(),
            updatedBy: req.user!.id,
          },
        });
      await req.audit('admin.module.settings.update', { slug });
      return { ok: true as const, settings: parsed.data };
    },
  );

  // ---------- GET /api/dashboard ----------
  // One round-trip overview used by the operator UI's landing page.
  app.get('/api/dashboard', { preHandler: requireUser }, async (req, reply) => {
    if (!require503(req.deps.inventory, reply, 'inventory')) return;

    const agents = req.deps.inventory.listAgents();
    const recentRuns = await req.deps.db
      .select({
        id: agentRuns.id,
        agentSlug: agentRuns.agentSlug,
        startedAt: agentRuns.startedAt,
        endedAt: agentRuns.endedAt,
        ok: agentRuns.ok,
        summary: agentRuns.summary,
      })
      .from(agentRuns)
      .orderBy(desc(agentRuns.startedAt))
      .limit(10);

    const instances = await req.deps.db.select().from(connectorInstances);
    const capabilityStatus: Array<{
      capability: string;
      registered: number;
      configured: number;
      activeProvider: string | null;
    }> = [];
    for (const cap of ['email', 'crm', 'llm', 'file-storage']) {
      const providers = req.deps.inventory.listConnectorProviders(cap);
      const capInstances = instances.filter((i) => i.capability === cap);
      const active = capInstances.find((i) => i.isActive);
      capabilityStatus.push({
        capability: cap,
        registered: providers.length,
        configured: capInstances.length,
        activeProvider: active ? active.providerSlug : null,
      });
    }

    return {
      agentCount: agents.length,
      recentRuns,
      capabilities: capabilityStatus,
    };
  });

  // ---------- GET /api/platform/composio ----------
  // Returns the Composio platform configuration status. Never reveals the key
  // value — only indicates whether a key has been saved by the operator.
  app.get('/api/platform/composio', { preHandler: [requireUser, requireRole('admin')] }, async (req) => {
    const key = await req.deps.secrets.get('platform:composio', 'api_key');
    return { configured: !!key };
  });

  // ---------- PUT /api/platform/composio ----------
  // Operator saves (or replaces) the Composio API key. The key is encrypted at
  // rest via the SecretsStore. The API never returns the key in any response.
  app.put('/api/platform/composio', { preHandler: [requireUser, requireRole('admin')] }, async (req, reply) => {
    const body = z.object({ apiKey: z.string().min(1) }).safeParse(req.body);
    if (!body.success) {
      reply.code(400).send({ error: 'invalid_input', hint: 'apiKey must be a non-empty string' });
      return;
    }
    await req.deps.secrets.put('platform:composio', 'api_key', body.data.apiKey);
    await req.audit('admin.platform.composio.api_key.update', {});
    return { ok: true as const };
  });

  // ---------- GET /api/audit ----------
  app.get('/api/audit', { preHandler: requireUser }, async (req) => {
    const q = req.query as {
      limit?: string;
      action?: string;
      userId?: string;
      agentSlug?: string;
      since?: string;
      before?: string;
    };
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);

    const filters: SQL[] = [];
    if (q.action) filters.push(eq(auditLog.action, q.action));
    if (q.userId) filters.push(eq(auditLog.userId, q.userId));
    if (q.agentSlug) filters.push(eq(auditLog.agentSlug, q.agentSlug));
    if (q.since) {
      const t = new Date(q.since);
      if (!Number.isNaN(t.getTime())) filters.push(gte(auditLog.at, t));
    }
    if (q.before) {
      const t = new Date(q.before);
      if (!Number.isNaN(t.getTime())) filters.push(lt(auditLog.at, t));
    }

    const rowsQuery = req.deps.db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        action: auditLog.action,
        userId: auditLog.userId,
        userEmail: users.email,
        agentSlug: auditLog.agentSlug,
        requestId: auditLog.requestId,
        meta: auditLog.meta,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.id))
      .orderBy(desc(auditLog.at))
      .limit(limit);
    const rows = await (filters.length
      ? rowsQuery.where(and(...filters))
      : rowsQuery);
    const nextBefore =
      rows.length === limit && rows[rows.length - 1]
        ? rows[rows.length - 1]!.at.toISOString()
        : null;
    return { entries: rows, nextBefore };
  });
}
