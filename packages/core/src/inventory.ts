/**
 * Minimal interfaces core needs from the runtime, defined here so core never
 * imports from @frontrangesystems/business-os-runtime (which would create a dependency cycle —
 * runtime already imports from core).
 *
 * The runtime's Registry and Scheduler satisfy these structurally.
 */

import type { z } from 'zod';
import type {
  ConnectorCapabilityMap,
  ConnectorCredentials,
} from '@frontrangesystems/business-os-connector-sdk';

/**
 * Minimal shape of the runtime's connector resolver that core needs to give
 * modules connector access. The runtime's createConnectorResolver() satisfies
 * this structurally. `moduleSlug` reads `module-bindings:<slug>` the same way
 * `agentSlug` reads `agent-bindings:<slug>`.
 */
export interface ConnectorResolverLike {
  resolve<C extends keyof ConnectorCapabilityMap>(
    capability: C,
    opts?: { providerSlug?: string; agentSlug?: string; moduleSlug?: string },
  ): Promise<ConnectorCapabilityMap[C]>;
  resolveBinding<C extends keyof ConnectorCapabilityMap>(
    capability: C,
    opts?: { providerSlug?: string; agentSlug?: string; moduleSlug?: string },
  ): Promise<{
    instanceId: string;
    providerSlug: string;
    capability: string;
    credentials: ConnectorCredentials;
  }>;
}

export interface AgentManifestLike<TSettings extends z.ZodTypeAny = z.ZodTypeAny> {
  slug: string;
  version: string;
  displayName: string;
  description: string;
  requiredConnectors: ReadonlyArray<string>;
  settingsSchema: TSettings;
  /** Optional per-run input schema. UI auto-renders a form when present. */
  inputSchema?: z.ZodTypeAny;
  schedule:
    | { kind: 'cron'; expr: string }
    | { kind: 'manual' }
    | { kind: 'event'; topic: string };
  /** Which trigger kinds the operator can switch the agent to. See AgentManifest. */
  supportedTriggers?: ReadonlyArray<'cron' | 'manual' | 'event'>;
}

export interface RegisteredAgentLike {
  manifest: AgentManifestLike;
}

export interface ConnectorManifestLike {
  slug: string;
  capability: string;
  version: string;
  displayName: string;
  authKind: 'oauth2' | 'api-key' | 'none' | 'custom';
  /**
   * Set when the connector uses an external OAuth broker (e.g. Composio).
   * Mirrors @frontrangesystems/business-os-connector-sdk's ConnectorManifest.externalOAuth.
   */
  externalOAuth?: {
    provider: 'composio';
    toolkit: string;
  };
  settingsSchema: z.ZodTypeAny;
  /**
   * Optional credential-field schema. Present when authKind === 'custom'
   * (e.g. IMAP, SMTP — anything needing more than a single API key).
   */
  credentialsSchema?: z.ZodTypeAny;
}

/**
 * Structural interface for external OAuth brokers (Composio, Nango, ...).
 * Core depends only on this shape; the client shell wires a concrete
 * implementation (e.g. ComposioSubstrate from @frontrangesystems/business-os-connector-composio)
 * into startServer's deps.
 *
 * Mirrors @frontrangesystems/business-os-connector-sdk's ExternalOAuthBroker.
 */
export interface ExternalOAuthBrokerLike {
  findOrCreateManagedAuthConfig(toolkit: string): Promise<{ id: string; toolkit: string }>;
  createConnectionLink(p: {
    userId: string;
    authConfigId: string;
    callbackUrl: string;
  }): Promise<{ connectionRequestId: string; redirectUrl: string }>;
  getActiveConnection(userId: string, toolkit: string): Promise<string | null>;
}

export interface RegisteredConnectorProviderLike {
  manifest: ConnectorManifestLike;
  capability: string;
  /**
   * Optional "test reachability" hook the connector implements. Core's
   * POST /api/connectors/:id/test calls this with the saved credentials +
   * parsed settings. Throwing surfaces as the test error in the UI.
   *
   * Method shorthand (not function-typed property) so concrete providers
   * with narrower `ctx` types — e.g. `ConnectorContext<MySettings>` —
   * remain assignable. See ModulePackageLike.registerRoutes for rationale.
   */
  verify?(ctx: {
    credentials: unknown;
    settings: unknown;
    logger: { info: (o: object | string, m?: string) => void; warn: (o: object | string, m?: string) => void; error: (o: object | string, m?: string) => void };
  }): Promise<void>;
}

export interface ModuleManifestLike<TSettings extends z.ZodTypeAny = z.ZodTypeAny> {
  slug: string;
  version: string;
  displayName: string;
  description: string;
  settingsSchema: TSettings;
  /** Connector capabilities the module binds to instances (module-bindings:<slug>). */
  requiredConnectors?: ReadonlyArray<string>;
  migrationsDir?: string;
  defaultAudience?: unknown;
}

export interface ModulePackageLike {
  manifest: ModuleManifestLike;
  // Method shorthand (not function-typed property) so concrete modules with
  // narrower ctx types — e.g. `RegisterRoutes<ZodObject<{...}>>` — remain
  // assignable. Function-typed properties are strictly variant under
  // `strictFunctionTypes`; methods are bivariant.
  registerRoutes?(app: unknown, ctx: unknown): void | Promise<void>;
  uiPages?: Array<{ path: string; navLabel?: string; audience?: unknown }>;
  /**
   * Contribute one card to the operator Dashboard. Mirrors module-sdk's
   * ModulePackage.dashboardContribution. Method shorthand + `never` ctx keeps
   * concrete modules (whose ctx is the specific `DashboardContext<TSettings>`)
   * structurally assignable under strictFunctionTypes — core invokes the real
   * hook off the concrete package in modules.ts, so the loose param type here is
   * purely for structural compatibility.
   */
  dashboardContribution?(ctx: never): Promise<{
    title: string;
    summary?: string;
    items: Array<{ title: string; subtitle?: string; href?: string; badge?: string }>;
    emptyText?: string;
    ctaLabel?: string;
    ctaHref?: string;
  } | null>;
  /**
   * Background workers the module owns, keyed by worker name. Mirrors
   * module-sdk's ModulePackage.backgroundWorkers. Each runs in the worker
   * process and is triggered by the module via ctx.enqueue — NOT an agent, so
   * it never appears in the Agents list.
   *
   * A `Record` value position is invariant, so a concrete module's
   * `ModuleBackgroundWorkerHandler<TSettings>` (whose `ctx` is the specific
   * `ModuleWorkerContext<TSettings>`) won't structurally match a handler typed
   * with `ctx: unknown`. Typing the params as `never` sidesteps that: under
   * `strictFunctionTypes` a function with `never` params is a supertype of any
   * handler (params are contravariant; `never` is assignable to every type), so
   * any concrete module's backgroundWorkers map is assignable here. Core never
   * calls these through this structural type — it pulls the real handlers off
   * the concrete module package in start.ts — so the loose param types are
   * purely for structural compatibility.
   */
  backgroundWorkers?: Record<string, (ctx: never, payload: never) => Promise<void>>;
}

/**
 * The framework's view of what's registered. Implemented by
 * @frontrangesystems/business-os-runtime's Registry.
 */
export interface AgentInventory {
  listAgents(): RegisteredAgentLike[];
  getAgent(slug: string): RegisteredAgentLike;
  listConnectorProviders(capability: string): RegisteredConnectorProviderLike[];
  /**
   * Optional — every capability with at least one registered provider.
   * Older Registry shapes may not implement it; callers fall back to the
   * framework's built-in capability list.
   */
  listCapabilities?(): string[];
  getConnectorProvider(
    capability: string,
    slug: string,
  ): RegisteredConnectorProviderLike;
  /** Optional — older Registry shapes may not implement it yet. */
  listModules?(): ModulePackageLike[];
  getModule?(slug: string): ModulePackageLike;
}

/** Implemented by @frontrangesystems/business-os-runtime's Scheduler. */
export interface ManualTriggerer {
  triggerManual(slug: string, input: unknown, triggeredBy: string): Promise<void>;
  /**
   * Optional hook called by the API after the operator changes an agent's
   * enable bit or schedule override. The scheduler re-reads state and
   * adjusts its in-process timers / event subscriptions accordingly.
   * Triggers that don't implement it require a process restart for changes
   * to take effect.
   */
  refreshAgent?(slug: string): Promise<void>;
  /**
   * Enqueue a durable background job by raw job name. The framework uses this
   * to let module routes kick off their own background workers (job name
   * `module:<slug>:<workerName>`). The client's trigger wires this to the
   * jobs backend's enqueue. Optional — when absent, module routes that call
   * ctx.enqueue throw (no jobs backend wired).
   */
  enqueueJob?(name: string, payload: unknown): Promise<void>;
  /**
   * Register a consumer for a raw job name. The framework uses this in the
   * WORKER process to attach each module background worker
   * (`module:<slug>:<workerName>`). The client's trigger wires this to the
   * jobs backend's subscribe. Optional — present only on triggers that own a
   * jobs backend running workers.
   */
  subscribeJob?(name: string, handler: (payload: unknown) => Promise<void>): Promise<void>;
  /**
   * The connector resolver, so modules can resolve their bound connector
   * instances (`ctx.connector` / `ctx.connectorCredentials`). The client's
   * trigger factory already constructs a resolver for the scheduler; it just
   * returns it here too. Optional — when absent, module connector access
   * throws with a clear "no resolver wired" message.
   */
  connectors?: ConnectorResolverLike;
}
