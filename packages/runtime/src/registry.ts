import type { z } from 'zod';
import type {
  AgentContext,
  AgentManifest,
  AgentResult,
} from '@frontrangesystems/business-os-agent-sdk';
import type {
  ConnectorCapabilityMap,
  ConnectorContext,
  ConnectorManifest,
  ConnectorPackage,
} from '@frontrangesystems/business-os-connector-sdk';
import type { ModulePackage } from '@frontrangesystems/business-os-module-sdk';

/**
 * The agent + connector registries.
 *
 * Per CLAUDE.md the client shell's `business-os.config.ts` declares which
 * agents and connectors are wired in. That config is what calls
 * `registry.registerAgent(...)` / `registry.registerConnectorProvider(...)`
 * before the runtime boots.
 *
 * The registry itself has no opinions about scheduling or runtime — it's a
 * typed lookup that the rest of the runtime consults.
 */

// `run` is declared as a method shorthand (not `run: AgentRun`) so that
// agents typed with narrower settings (e.g. `AgentRun<{...settings...}, unknown>`)
// remain assignable. Function-typed properties are strictly variant under
// `strictFunctionTypes`; method shorthands are bivariant in parameters.
//
// `manifest` uses `AgentManifest<any>` (not `AgentManifest<z.ZodTypeAny>`) for
// the same reason: adding `actions?: Record<string, ActionDefinition<z.infer<T>>>`
// made T invariant in AgentManifest, so `AgentManifest<ZodObject<...>>` is not
// assignable to `AgentManifest<ZodTypeAny>` under strictFunctionTypes. `any`
// bypasses the invariant check — the registry never needs the specific type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RegisteredAgent {
  manifest: AgentManifest<any>;
  run(ctx: AgentContext<unknown>, input: unknown): Promise<AgentResult>;
}

// Stored shape for a connector provider. Built from a `ConnectorPackage`
// at registration time; `capability` is hoisted off the manifest so
// downstream consumers (admin routes, scheduler) can read it directly.
export interface RegisteredConnectorProvider<
  C extends keyof ConnectorCapabilityMap = keyof ConnectorCapabilityMap,
> {
  manifest: ConnectorManifest<z.ZodTypeAny>;
  capability: C;
  factory(ctx: ConnectorContext<unknown>): ConnectorCapabilityMap[C];
  verify?(ctx: ConnectorContext<unknown>): Promise<void>;
}

export class DuplicateAgentSlugError extends Error {
  constructor(slug: string) {
    super(`Agent slug "${slug}" is already registered`);
    this.name = 'DuplicateAgentSlugError';
  }
}
export class DuplicateConnectorProviderError extends Error {
  constructor(capability: string, slug: string) {
    super(`Connector provider "${slug}" for capability "${capability}" is already registered`);
    this.name = 'DuplicateConnectorProviderError';
  }
}
export class UnknownAgentError extends Error {
  constructor(slug: string) {
    super(`No agent registered with slug "${slug}"`);
    this.name = 'UnknownAgentError';
  }
}
export class UnknownConnectorProviderError extends Error {
  constructor(capability: string, slug: string) {
    super(`No connector provider "${slug}" registered for capability "${capability}"`);
    this.name = 'UnknownConnectorProviderError';
  }
}

export class DuplicateModuleSlugError extends Error {
  constructor(slug: string) {
    super(`Module slug "${slug}" is already registered`);
    this.name = 'DuplicateModuleSlugError';
  }
}
export class UnknownModuleError extends Error {
  constructor(slug: string) {
    super(`No module registered with slug "${slug}"`);
    this.name = 'UnknownModuleError';
  }
}

export class Registry {
  private agents = new Map<string, RegisteredAgent>();
  private providers = new Map<string, Map<string, RegisteredConnectorProvider>>();
  private modules = new Map<string, ModulePackage>();

  registerAgent(agent: RegisteredAgent): void {
    const slug = agent.manifest.slug;
    if (this.agents.has(slug)) throw new DuplicateAgentSlugError(slug);
    this.agents.set(slug, agent);
  }

  /**
   * Batch-register every agent in `agents`. Used by client shells to wire
   * `@frontrangesystems/business-os-agents-all` in one line instead of N individual calls.
   * Fails fast on the first duplicate slug, leaving previously-registered
   * agents in place.
   */
  registerManyAgents(agents: ReadonlyArray<RegisteredAgent>): void {
    for (const a of agents) this.registerAgent(a);
  }

  /**
   * Batch-register every connector in `packages`. Used by client shells
   * to wire `@frontrangesystems/business-os-connectors-all` in one line instead of N
   * individual calls. Fails fast on the first duplicate, leaving previously-
   * registered providers in place.
   */
  registerMany<C extends keyof ConnectorCapabilityMap>(
    packages: ReadonlyArray<ConnectorPackage<C>>,
  ): void {
    for (const p of packages) this.registerConnectorProvider(p);
  }

  registerConnectorProvider<C extends keyof ConnectorCapabilityMap>(
    pkg: ConnectorPackage<C>,
  ): void {
    // The capability is the source of truth on the connector's manifest.
    // We hoist it onto the stored RegisteredConnectorProvider so downstream
    // consumers (admin routes, scheduler) can read provider.capability
    // without re-reading the manifest each time.
    // ConnectorManifest.capability is typed as `keyof ConnectorCapabilityMap`
    // (not the narrow `C` of the package's generic), so we narrow here.
    // Safe because callers parameterize registerConnectorProvider<C> against
    // a connector whose manifest matches.
    const cap = pkg.manifest.capability as C;
    const slug = pkg.manifest.slug;
    let byCap = this.providers.get(cap as string);
    if (!byCap) {
      byCap = new Map();
      this.providers.set(cap as string, byCap);
    }
    if (byCap.has(slug)) throw new DuplicateConnectorProviderError(cap as string, slug);
    const stored: RegisteredConnectorProvider<C> = {
      manifest: pkg.manifest,
      capability: cap,
      factory: pkg.factory as RegisteredConnectorProvider<C>['factory'],
      ...(pkg.verify ? { verify: pkg.verify as RegisteredConnectorProvider<C>['verify'] } : {}),
    };
    byCap.set(slug, stored as RegisteredConnectorProvider);
  }

  getAgent(slug: string): RegisteredAgent {
    const a = this.agents.get(slug);
    if (!a) throw new UnknownAgentError(slug);
    return a;
  }

  listAgents(): RegisteredAgent[] {
    return [...this.agents.values()];
  }

  getConnectorProvider<C extends keyof ConnectorCapabilityMap>(
    capability: C,
    providerSlug: string,
  ): RegisteredConnectorProvider<C> {
    const byCap = this.providers.get(capability as string);
    const p = byCap?.get(providerSlug);
    if (!p) throw new UnknownConnectorProviderError(capability as string, providerSlug);
    return p as RegisteredConnectorProvider<C>;
  }

  listConnectorProviders<C extends keyof ConnectorCapabilityMap>(
    capability: C,
  ): RegisteredConnectorProvider<C>[] {
    const byCap = this.providers.get(capability as string);
    return byCap ? ([...byCap.values()] as RegisteredConnectorProvider<C>[]) : [];
  }

  // ---- Modules ----

  registerModule<TSettings extends z.ZodTypeAny>(
    mod: ModulePackage<TSettings>,
  ): void {
    const slug = mod.manifest.slug;
    if (this.modules.has(slug)) throw new DuplicateModuleSlugError(slug);
    // Stored as ModulePackage<ZodTypeAny>. Generic invariance means
    // ModulePackage<ZodObject<...>> isn't directly assignable, so the cast
    // is necessary; runtime treats all modules uniformly so this is safe.
    this.modules.set(slug, mod as unknown as ModulePackage);
  }

  getModule(slug: string): ModulePackage {
    const m = this.modules.get(slug);
    if (!m) throw new UnknownModuleError(slug);
    return m;
  }

  listModules(): ModulePackage[] {
    return [...this.modules.values()];
  }
}
