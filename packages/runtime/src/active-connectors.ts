import { eq, and } from 'drizzle-orm';
import type { Db } from '@frontrangesystems/business-os-db';
import { connectorInstances, settings } from '@frontrangesystems/business-os-db';
import type { SecretsStore } from '@frontrangesystems/business-os-core/secrets';
import type {
  ConnectorCapabilityMap,
  ConnectorContext,
  ConnectorCredentials,
} from '@frontrangesystems/business-os-connector-sdk';
import type { Registry } from './registry.js';
import type { Logger } from 'pino';

/**
 * Resolves the connector an agent OR module should use for each capability.
 *
 * Resolution modes:
 *  - **Agent-scoped (`{ agentSlug }`)** — look up the agent's bindings
 *    (`agent-bindings:<slug>`) and resolve to the specific instance the operator
 *    picked. Fails loud if the binding is missing.
 *  - **Module-scoped (`{ moduleSlug }`)** — same, but reads `module-bindings:<slug>`.
 *    Lets a module bind each capability it declares to a specific connector
 *    instance, exactly like agents.
 *  - **`{ providerSlug }`** — the named provider (any instance). Tooling only.
 *  - **Default** (no context) — the first active instance for the capability.
 *    Legacy path for ad-hoc callers / tests.
 *
 * Per CLAUDE.md: agents/modules call `ctx.connector('email')` — never name a
 * provider. Multiple instances per capability are allowed; the binding map
 * disambiguates.
 */

export interface ResolvedBinding {
  instanceId: string;
  providerSlug: string;
  capability: string;
  /** Decrypted credentials for the bound instance. */
  credentials: ConnectorCredentials;
}

export interface ConnectorResolver {
  /**
   * Resolve a connector capability object.
   * - `{ agentSlug }` / `{ moduleSlug }`: resolve the bound instance (throws if
   *   no binding exists for `capability`).
   * - `{ providerSlug }`: the named provider (any instance). Tooling.
   * - Default: the first active instance for `capability`. Legacy.
   */
  resolve<C extends keyof ConnectorCapabilityMap>(
    capability: C,
    opts?: { providerSlug?: string; agentSlug?: string; moduleSlug?: string },
  ): Promise<ConnectorCapabilityMap[C]>;
  /**
   * Resolve the bound instance's decrypted credentials + provider metadata
   * WITHOUT instantiating the capability. Escape hatch for callers that need
   * the raw credential because the capability interface can't express their
   * use (e.g. a module doing Claude vision, which the text-only `llm`
   * capability doesn't support). Same binding rules as `resolve()`.
   */
  resolveBinding<C extends keyof ConnectorCapabilityMap>(
    capability: C,
    opts?: { providerSlug?: string; agentSlug?: string; moduleSlug?: string },
  ): Promise<ResolvedBinding>;
}

export interface ResolverDeps {
  db: Db;
  secrets: SecretsStore;
  registry: Registry;
  logger: Logger;
}

export class NoActiveConnectorError extends Error {
  constructor(capability: string) {
    super(`No active connector configured for capability "${capability}"`);
    this.name = 'NoActiveConnectorError';
  }
}

export class MissingAgentBindingError extends Error {
  constructor(agentSlug: string, capability: string) {
    super(
      `Agent "${agentSlug}" has no connector binding for capability "${capability}". ` +
        `Open the agent's Settings page and pick a connector instance.`,
    );
    this.name = 'MissingAgentBindingError';
  }
}

export class MissingModuleBindingError extends Error {
  constructor(moduleSlug: string, capability: string) {
    super(
      `Module "${moduleSlug}" has no connector binding for capability "${capability}". ` +
        `Open the module's Settings page and pick a connector instance.`,
    );
    this.name = 'MissingModuleBindingError';
  }
}

const CREDENTIAL_KEY = 'credentials';
const AGENT_BINDINGS_SCOPE = (slug: string): string => `agent-bindings:${slug}`;
const MODULE_BINDINGS_SCOPE = (slug: string): string => `module-bindings:${slug}`;

async function loadBindings(db: Db, scope: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.scope, scope))
    .limit(1);
  const v = rows[0]?.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string>;
  return {};
}

type ResolveOpts = { providerSlug?: string; agentSlug?: string; moduleSlug?: string };

interface InstanceRow {
  id: string;
  providerSlug: string;
  capability: string;
}

export function createConnectorResolver(deps: ResolverDeps): ConnectorResolver {
  /**
   * Shared: find the connector-instance row for a capability, honoring
   * agent/module bindings, an explicit provider, or the active-instance
   * fallback. Fails loud when a declared binding is missing or dangling.
   */
  async function resolveInstanceRow(cap: string, opts?: ResolveOpts): Promise<InstanceRow> {
    let instanceId: string | undefined;
    let bindingScope: 'agent' | 'module' | null = null;
    if (opts?.agentSlug && !opts?.providerSlug) {
      const bindings = await loadBindings(deps.db, AGENT_BINDINGS_SCOPE(opts.agentSlug));
      instanceId = bindings[cap];
      if (!instanceId) throw new MissingAgentBindingError(opts.agentSlug, cap);
      bindingScope = 'agent';
    } else if (opts?.moduleSlug && !opts?.providerSlug) {
      const bindings = await loadBindings(deps.db, MODULE_BINDINGS_SCOPE(opts.moduleSlug));
      instanceId = bindings[cap];
      if (!instanceId) throw new MissingModuleBindingError(opts.moduleSlug, cap);
      bindingScope = 'module';
    }

    const where = instanceId
      ? eq(connectorInstances.id, instanceId)
      : opts?.providerSlug
        ? and(
            eq(connectorInstances.capability, cap),
            eq(connectorInstances.providerSlug, opts.providerSlug),
          )
        : and(eq(connectorInstances.capability, cap), eq(connectorInstances.isActive, true));

    const rows = await deps.db
      .select({
        id: connectorInstances.id,
        providerSlug: connectorInstances.providerSlug,
        capability: connectorInstances.capability,
      })
      .from(connectorInstances)
      .where(where)
      .limit(1);
    const row = rows[0];
    if (!row) {
      if (instanceId) {
        const where_ = bindingScope === 'module' ? 'module settings' : 'agent settings';
        throw new NoActiveConnectorError(
          `${cap} (bound instance ${instanceId} no longer exists — re-bind in ${where_})`,
        );
      }
      if (opts?.providerSlug) {
        throw new NoActiveConnectorError(`${cap} (no instance for provider "${opts.providerSlug}")`);
      }
      throw new NoActiveConnectorError(cap);
    }
    if (instanceId && row.capability !== cap) {
      throw new NoActiveConnectorError(
        `${cap} (bound instance ${instanceId} is for capability "${row.capability}")`,
      );
    }
    return row;
  }

  /** Load + decrypt the bound instance's credentials. */
  async function loadCredentials(cap: string, instanceId: string): Promise<ConnectorCredentials> {
    const scope = `connector:${cap}:${instanceId}`;
    const credentialsJson = await deps.secrets.get(scope, CREDENTIAL_KEY);
    return credentialsJson
      ? (JSON.parse(credentialsJson) as ConnectorCredentials)
      : { kind: 'none' };
  }

  return {
    async resolve<C extends keyof ConnectorCapabilityMap>(
      capability: C,
      opts?: ResolveOpts,
    ): Promise<ConnectorCapabilityMap[C]> {
      const cap = capability as string;
      const row = await resolveInstanceRow(cap, opts);
      const provider = deps.registry.getConnectorProvider(capability, row.providerSlug);
      const scope = `connector:${cap}:${row.id}`;

      const credentials = await loadCredentials(cap, row.id);

      // settings (non-secret) — load by scope; validate against the provider schema.
      const settingsRows = await deps.db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.scope, scope))
        .limit(1);
      const rawSettings = settingsRows[0]?.value ?? {};
      const parsedSettings = provider.manifest.settingsSchema.parse(rawSettings) as unknown;

      const childLogger = deps.logger.child({
        connector: { capability: cap, provider: row.providerSlug, instance_id: row.id },
      });
      const ctx: ConnectorContext<unknown> = {
        credentials,
        settings: parsedSettings,
        logger: {
          info: (o, m) => childLogger.info(o as object, m),
          warn: (o, m) => childLogger.warn(o as object, m),
          error: (o, m) => childLogger.error(o as object, m),
        },
        refreshOAuth: async (newCreds: ConnectorCredentials) => {
          await deps.secrets.put(scope, CREDENTIAL_KEY, JSON.stringify(newCreds));
        },
      };
      return provider.factory(ctx) as ConnectorCapabilityMap[C];
    },

    async resolveBinding<C extends keyof ConnectorCapabilityMap>(
      capability: C,
      opts?: ResolveOpts,
    ): Promise<ResolvedBinding> {
      const cap = capability as string;
      const row = await resolveInstanceRow(cap, opts);
      const credentials = await loadCredentials(cap, row.id);
      return { instanceId: row.id, providerSlug: row.providerSlug, capability: cap, credentials };
    },
  };
}
