import type { z } from 'zod';
import type { ComponentType } from 'react';
import type {
  ConnectorCapabilityMap,
  ConnectorCredentials,
} from '@frontrangesystems/business-os-connector-sdk';

/**
 * Module — the third framework primitive, alongside agents and connectors.
 *
 *   - **Agent**: pull, summarize, propose, audit. Async, episodic.
 *   - **Connector**: talks to a system outside this install on agents' behalf.
 *   - **Module**: owns a slice of business state — its own tables, REST routes,
 *     and (optionally) UI pages. Agents read/write a module's data via its
 *     REST surface, just like agents call connectors.
 *
 * A module is **standalone**: an install can have zero modules, one, or N.
 * Modules don't reach into each other's tables; they cross-talk through their
 * REST routes the same way an agent would.
 *
 * Example shape (no business logic — see modules/example/):
 *   defineModule({
 *     manifest: {
 *       slug: 'inventory',
 *       version: '0.0.1',
 *       displayName: 'Inventory',
 *       description: 'Tracks SKUs, on-hand counts, reorder points.',
 *       settingsSchema: z.object({ defaultReorderDays: z.number().default(14) }),
 *       migrationsDir: resolve(here, '..', 'migrations'),
 *     },
 *     registerRoutes: (app, ctx) => {
 *       app.get('/items', async () => ctx.db.select().from(items));
 *       app.post('/items', async (req) => ctx.db.insert(items).values(req.body));
 *     },
 *     uiPages: [
 *       { path: '', navLabel: 'Items', Component: ItemsList },
 *       { path: 'low-stock', navLabel: 'Low stock', Component: LowStock },
 *     ],
 *   });
 */

/**
 * Audience tag — same shape used elsewhere for permissions. A module page can
 * declare its default audience; operators can override per install. Until the
 * permissions PR lands, audience is informational only.
 */
export type AudienceTag =
  | { kind: 'everyone' }
  | { kind: 'admins' }
  | { kind: 'departments'; departments: string[] };

export interface ModuleManifest<TSettings extends z.ZodTypeAny = z.ZodTypeAny> {
  /** kebab-case unique identifier within the install. */
  slug: string;
  /** semver of the module package. */
  version: string;
  /** Human-readable name shown in the operator UI's sidebar. */
  displayName: string;
  /** One-line description. */
  description: string;
  /** Per-install settings — auto-rendered as a form by core, same as agents. */
  settingsSchema: TSettings;
  /**
   * Connector capabilities this module needs. Declaring them makes the
   * operator UI render an instance-picker (same one agents use) so the
   * operator binds each capability to a specific connector instance, stored at
   * `module-bindings:<slug>`. The module then resolves the bound instance via
   * `ctx.connector(capability)` / `ctx.connectorCredentials(capability)`.
   * Omit for modules that don't call connectors.
   */
  requiredConnectors?: ReadonlyArray<keyof ConnectorCapabilityMap>;
  /**
   * Absolute path to a directory of .sql migrations the module owns.
   * Forward-only, same runner as everything else. Omit if the module has
   * no schema.
   */
  migrationsDir?: string;
  /** Default audience tag for the module's UI pages + routes. */
  defaultAudience?: AudienceTag;
}

/**
 * A module's resolved connector binding — the operator-chosen instance for a
 * capability, plus its decrypted credentials. Returned by
 * `ctx.connectorCredentials(capability)`. This is the escape hatch for modules
 * that need the raw credential because the capability interface can't express
 * their use (e.g. a module doing Claude vision, which the text-only `llm`
 * capability doesn't support). Most modules should use `ctx.connector()`.
 */
export interface ModuleConnectorBinding {
  /** The bound connector-instance id. */
  instanceId: string;
  /** The bound instance's provider slug (e.g. 'anthropic'). */
  providerSlug: string;
  /** Decrypted credentials for the bound instance. */
  credentials: ConnectorCredentials;
}

/**
 * Connector access shared by the module's route + worker contexts. Available
 * only for capabilities the module declared in `manifest.requiredConnectors`
 * AND the operator has bound to an instance; throws otherwise.
 */
export interface ModuleConnectorAccess {
  /**
   * Resolve the operator-bound connector instance for `capability` as a
   * capability object (e.g. an `EmailCapability`). Throws if the module didn't
   * declare the capability or the operator hasn't bound an instance.
   */
  connector<C extends keyof ConnectorCapabilityMap>(
    capability: C,
  ): Promise<ConnectorCapabilityMap[C]>;
  /**
   * Resolve the bound instance's decrypted credentials + provider WITHOUT
   * instantiating the capability. Escape hatch for raw-credential needs (see
   * ModuleConnectorBinding). Throws under the same conditions as `connector`.
   */
  connectorCredentials<C extends keyof ConnectorCapabilityMap>(
    capability: C,
  ): Promise<ModuleConnectorBinding>;
}

/**
 * Context handed to the module's server-side registerRoutes.
 *
 * Routes are mounted under `/api/modules/<slug>` by core (e.g. a route defined as
 * `app.get('/items')` resolves at `/api/modules/inventory/items`). The /api/
 * prefix keeps API routes from colliding with SPA routes. Auth is shared
 * with the rest of the framework; req.user is populated.
 *
 * `db` is the same Drizzle handle the framework uses — modules can read their
 * own tables freely and can read core/agent/connector tables too if needed.
 * Modules MUST NOT touch other modules' tables directly; cross-module data
 * crosses through the REST surface.
 */
export interface ModuleServerContext<TSettings = unknown> extends ModuleConnectorAccess {
  /** Decrypted, parsed module settings (validated against the manifest schema). */
  settings: TSettings;
  /**
   * Module-scoped logger pre-tagged with `module_slug`, built once at route
   * registration. Use it for boot/registration lines and anything not tied to a
   * specific request. For PER-REQUEST logging inside a route handler, prefer the
   * request logger (`req.log`): the framework binds it with client_slug +
   * request_id + user_id, so a line like `req.log.info({ bidId }, 'bid.uploaded')`
   * is fully correlated to the request and the authenticated user.
   */
  logger: ModuleLogger;
  /**
   * Enqueue one of this module's own background workers (see
   * `backgroundWorkers`). The framework routes the job to the matching handler
   * running in the WORKER process under the name `module:<slug>:<workerName>`,
   * so it never collides with an agent slug and never runs as an agent.
   *
   * Returns once the job is durably enqueued (pg-boss persists it); the handler
   * runs asynchronously in the worker. Use this from `registerRoutes` to kick
   * off background work in response to a request (e.g. index a freshly uploaded
   * document).
   */
  enqueue(workerName: string, payload?: unknown): Promise<void>;
}

/**
 * Context handed to a module's background-worker handler when it runs in the
 * worker process. Deliberately minimal and db-free: the SDK stays free of
 * Drizzle / Postgres types, so a handler builds its own db from
 * `process.env.DATABASE_URL` exactly like the module's routes do.
 */
export interface ModuleWorkerContext<TSettings = unknown> extends ModuleConnectorAccess {
  /** Decrypted, parsed module settings (validated against the manifest schema). */
  settings: TSettings;
  /** Module-scoped logger pre-tagged with `module_slug` + the worker name. */
  logger: ModuleLogger;
}

/**
 * A background worker a module owns. Runs in the WORKER process, is triggered
 * by the module itself via `ctx.enqueue(name, payload)`, and is NOT a
 * user-facing agent: it never appears in the operator's Agents list, has no
 * enable bit, and has no schedule.
 */
export type ModuleBackgroundWorkerHandler<TSettings = unknown> = (
  ctx: ModuleWorkerContext<TSettings>,
  payload: unknown,
) => Promise<void>;

export interface ModuleLogger {
  trace(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

/**
 * Function shape modules export to register their REST routes. Receives the
 * Fastify-typed app instance + module context.
 *
 * We type the app as `unknown` here so module-sdk doesn't depend on Fastify
 * directly (keeps the SDK runtime-neutral; modules import their own Fastify
 * types if they want them).
 */
export type RegisterRoutes<TSettings = unknown> = (
  app: unknown,
  ctx: ModuleServerContext<TSettings>,
) => void | Promise<void>;

/**
 * A UI page a module contributes. The operator UI sticks these under
 * `/modules/<slug>/<path>` in its router and renders the Component there.
 *
 * The Component is a React component; the module-sdk lists `react` as a peer
 * dep (via the UI bundler) but does not import from it at runtime.
 */
export interface ModuleUiPage {
  /**
   * Subpath within the module. Empty string means the module's index page.
   * No leading slash.
   */
  path: string;
  /**
   * Label in the operator UI's sidebar. When omitted the page is reachable
   * via direct URL but not in the nav (useful for detail pages).
   */
  navLabel?: string;
  /** React component rendered inside the operator shell. */
  Component: ComponentType<Record<string, never>>;
  /** Override the module's defaultAudience for this specific page. */
  audience?: AudienceTag;
}

/**
 * One section of the daily digest, contributed by a module. The digest
 * agent (`@frontrangesystems/business-os-agent-digest`) calls each module's
 * digestContribution per user, drops empty contributions, and composes
 * one email per user from what's left.
 *
 * Return `null` (or `items: []`) to skip this user's digest for this run.
 */
export interface DigestContribution {
  /** Heading shown above this module's items. */
  sectionTitle: string;
  /** Optional one-line lead under the title. */
  summary?: string;
  items: Array<{
    title: string;
    subtitle?: string;
    /** Deep link to the dashboard or a detail page for this item. */
    href: string;
    /** When true, raises an [URGENT] email separate from the morning send. */
    isUrgent?: boolean;
  }>;
}

export interface DigestContext<TSettings = unknown> {
  /** The user the digest is being built for. */
  user: { id: string; email: string };
  /** When this user last received a digest. First-time = installDate-ish. */
  since: Date;
  /** Module-scoped logger pre-tagged with module_slug + user_id. */
  logger: ModuleLogger;
  /** Decrypted, parsed module settings. */
  settings: TSettings;
}

export interface ModulePackage<TSettings extends z.ZodTypeAny = z.ZodTypeAny> {
  manifest: ModuleManifest<TSettings>;
  /**
   * Register Fastify routes for this module. Called once at boot. Optional —
   * a module can be UI-only.
   */
  registerRoutes?: RegisterRoutes<z.infer<TSettings>>;
  /**
   * UI pages this module contributes. Optional — a module can be
   * server-only.
   */
  uiPages?: ModuleUiPage[];
  /**
   * Contribute a section to the daily digest. Called once per user per
   * digest run. Optional — modules without digest content can omit.
   */
  digestContribution?: (ctx: DigestContext<z.infer<TSettings>>) => Promise<DigestContribution | null>;
  /**
   * Background workers this module owns, keyed by worker name. Each runs in
   * the WORKER process and is triggered by the module itself via
   * `ctx.enqueue(name, payload)` — never by the operator. They are NOT agents:
   * no Agents-list entry, no enable bit, no schedule. The framework registers
   * each under the job name `module:<slug>:<name>`. Optional.
   */
  backgroundWorkers?: Record<string, ModuleBackgroundWorkerHandler<z.infer<TSettings>>>;
}

/**
 * Helper: defines a module so TSettings is inferred from the manifest's
 * settingsSchema. Same pattern as defineAgent / defineConnector.
 */
export function defineModule<TSettings extends z.ZodTypeAny>(
  pkg: ModulePackage<TSettings>,
): ModulePackage<TSettings> {
  return pkg;
}
