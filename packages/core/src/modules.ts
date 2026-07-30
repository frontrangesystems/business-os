import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { settings as settingsTable, type Db } from '@frontrangesystems/business-os-db';
import type { AppDeps } from './app.js';
import type {
  AgentInventory,
  ConnectorResolverLike,
  ManualTriggerer,
  ModulePackageLike,
} from './inventory.js';

/**
 * Build the `connector` / `connectorCredentials` accessors for a module's
 * context. Both resolve through the shared resolver with `{ moduleSlug }`, so a
 * module only ever reaches the connector instance the operator bound to it
 * (`module-bindings:<slug>`). Throws a clear error if no resolver is wired.
 */
function buildModuleConnectorAccess(
  connectors: ConnectorResolverLike | undefined,
  slug: string,
): {
  connector: (capability: string) => Promise<unknown>;
  connectorCredentials: (
    capability: string,
  ) => Promise<{ instanceId: string; providerSlug: string; credentials: unknown }>;
} {
  const require = (method: string): ConnectorResolverLike => {
    if (!connectors) {
      throw new Error(
        `module ${slug}: ctx.${method} called but no connector resolver is wired (trigger.connectors missing)`,
      );
    }
    return connectors;
  };
  return {
    connector: (capability) =>
      require('connector').resolve(capability as never, { moduleSlug: slug }),
    connectorCredentials: async (capability) => {
      const b = await require('connectorCredentials').resolveBinding(capability as never, {
        moduleSlug: slug,
      });
      return { instanceId: b.instanceId, providerSlug: b.providerSlug, credentials: b.credentials };
    },
  };
}

/**
 * Server-side wiring for modules.
 *
 * For each module in the inventory:
 *   1. Load its persisted settings from the `settings` table
 *      (scope = `module:<slug>`), validate against the manifest schema,
 *      use defaults if no row exists.
 *   2. Build a module-scoped logger (pino child tagged with module_slug).
 *   3. Register the module's routes under a Fastify prefix
 *      `/api/modules/<slug>` so a `app.get('/items')` in the module renders at
 *      `/api/modules/inventory/items`.
 *
 * The /api/ prefix exists to keep API routes from colliding with SPA routes.
 * Without it, hard navigation to `/modules/inventory/items` (a typed URL,
 * a refresh, a bookmark) would hit the Fastify JSON route instead of falling
 * through to the SPA router that renders the UI page.
 *
 * Cross-module isolation is by convention: modules may read/write only their
 * own tables. We don't enforce it at the DB layer.
 */

const SETTINGS_SCOPE = (slug: string): string => `module:${slug}`;

export async function registerModuleRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  if (!deps.inventory?.listModules) return;
  const modules = deps.inventory.listModules();
  for (const mod of modules) {
    if (!mod.registerRoutes) continue;

    // Settings are re-read on every request (same rule as background workers,
    // which resolve fresh per job) so operator changes in the settings UI take
    // effect immediately — on every machine — without a restart. `current`
    // starts as the boot-time load so anything the module reads during
    // registration sees valid settings; the onRequest hook in the scope below
    // refreshes it before each handler runs. ctx.settings is a Proxy over
    // `current` so the module's closed-over reference stays live, including
    // spread/JSON.stringify access.
    let current = await loadModuleSettings(deps.db, mod);
    const liveSettings = new Proxy({} as Record<string | symbol, unknown>, {
      get: (_t, key) => Reflect.get(current as object, key),
      has: (_t, key) => Reflect.has(current as object, key),
      ownKeys: () => Reflect.ownKeys(current as object),
      getOwnPropertyDescriptor: (_t, key) =>
        Object.getOwnPropertyDescriptor(current as object, key) ?? {
          configurable: true,
          enumerable: true,
          value: undefined,
        },
    });
    const childLogger = app.log.child({ module_slug: mod.manifest.slug });

    // ctx.enqueue routes to the module's own background workers under the job
    // name `module:<slug>:<workerName>`. The trigger (which owns the jobs
    // backend) does the actual enqueue; in the API process it was started
    // enqueue-only so this works without running any consumers here. If no
    // trigger / jobs backend is wired, enqueue throws a clear error.
    const slug = mod.manifest.slug;
    const enqueue = async (workerName: string, payload?: unknown): Promise<void> => {
      const enqueueJob = deps.trigger?.enqueueJob;
      if (!enqueueJob) {
        throw new Error(
          `module ${slug}: ctx.enqueue('${workerName}') called but no jobs backend is wired (trigger.enqueueJob missing)`,
        );
      }
      await enqueueJob(`module:${slug}:${workerName}`, payload);
    };

    await app.register(
      async (scope) => {
        // Refresh the settings snapshot before every request in this module's
        // scope. Single-row PK lookup — same cost profile as the session check
        // every authenticated request already does.
        scope.addHook('onRequest', async () => {
          current = await loadModuleSettings(deps.db, mod);
        });
        // Cast through unknown — the module-sdk types `app` as unknown to stay
        // runtime-neutral. Inside this closure it's a normal FastifyInstance.
        await Promise.resolve(
          (mod.registerRoutes as (a: unknown, c: unknown) => void | Promise<void>)(scope, {
            settings: liveSettings,
            logger: childLogger,
            enqueue,
            ...buildModuleConnectorAccess(deps.trigger?.connectors, slug),
          }),
        );
      },
      { prefix: `/api/modules/${mod.manifest.slug}` },
    );
    app.log.info(
      { module: mod.manifest.slug },
      'module routes registered',
    );
  }
}

/**
 * One rendered dashboard card, as returned to the UI by GET /api/dashboard.
 * Shape mirrors module-sdk's DashboardContribution plus the owning module's
 * slug (so the UI can key/label cards).
 */
export interface DashboardCard {
  moduleSlug: string;
  title: string;
  summary?: string;
  items: Array<{ title: string; subtitle?: string; href?: string; badge?: string }>;
  emptyText?: string;
  ctaLabel?: string;
  ctaHref?: string;
}

/**
 * Aggregate every registered module's dashboard contribution for `user`.
 *
 * For each module that declares `dashboardContribution`: load its persisted
 * settings (defaults applied), build a module-scoped logger tagged with
 * module_slug + user_id, and invoke the hook. A hook that throws is logged and
 * skipped so one broken module never blanks the whole dashboard. Cards preserve
 * module registration order; a hook returning `null` drops its card.
 */
/**
 * Minimal logger shape collectDashboardCards needs — satisfied by both a pino
 * `Logger` and Fastify's `req.log`/`app.log` (`FastifyBaseLogger`), so callers
 * can pass whichever they have without a cast.
 */
interface DashboardLogger {
  child(bindings: Record<string, unknown>): DashboardLogger;
  warn(obj: object, msg?: string): void;
}

export async function collectDashboardCards(opts: {
  db: Db;
  inventory: AgentInventory;
  logger: DashboardLogger;
  user: { id: string; email: string };
}): Promise<DashboardCard[]> {
  const { db, inventory, logger, user } = opts;
  if (!inventory.listModules) return [];
  const cards: DashboardCard[] = [];
  for (const mod of inventory.listModules()) {
    if (!mod.dashboardContribution) continue;
    const slug = mod.manifest.slug;
    try {
      const settings = await loadModuleSettings(db, mod);
      const childLogger = logger.child({ module_slug: slug, user_id: user.id });
      // module-sdk types the hook's ctx as the concrete DashboardContext; the
      // structural ModulePackageLike types it as `never`. Cast to the real call
      // shape to invoke it here.
      const invoke = mod.dashboardContribution as unknown as (ctx: {
        user: { id: string; email: string };
        logger: typeof childLogger;
        settings: unknown;
      }) => Promise<DashboardCard | null>;
      const contribution = await invoke({ user, logger: childLogger, settings });
      if (!contribution) continue;
      cards.push({ ...contribution, moduleSlug: slug });
    } catch (err) {
      logger.warn({ err, module_slug: slug }, 'dashboardContribution failed; skipping card');
    }
  }
  return cards;
}

async function loadModuleSettings(
  db: Db,
  mod: ModulePackageLike,
): Promise<unknown> {
  const rows = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.scope, SETTINGS_SCOPE(mod.manifest.slug)))
    .limit(1);
  const raw = rows[0]?.value ?? {};
  // Module manifests carry Zod schemas; parse with defaults applied.
  const parsed = (mod.manifest.settingsSchema as { parse: (v: unknown) => unknown }).parse(raw);
  return parsed;
}

/**
 * WORKER-side wiring for module background workers.
 *
 * For every registered module that declares `backgroundWorkers`, subscribe a
 * consumer under the job name `module:<slug>:<workerName>` on the trigger's
 * jobs backend (which the worker process started with consumers running). When
 * a job arrives, the framework resolves the module's decrypted settings (same
 * as its routes), builds a logger tagged with `module_slug` + the worker name,
 * and invokes the handler with `{ settings, logger }` + the job payload.
 *
 * These are NOT agents: they never enter the registry, the Agents list, or the
 * enable flow. The only way they run is a `module:*` job enqueued by the
 * module itself.
 *
 * No-op when the trigger doesn't expose `subscribeJob` (e.g. no jobs backend,
 * or an API-only process that shouldn't run consumers).
 */
export async function registerModuleBackgroundWorkers(opts: {
  db: Db;
  inventory: AgentInventory;
  trigger: ManualTriggerer | undefined;
  logger: Logger;
}): Promise<void> {
  const subscribeJob = opts.trigger?.subscribeJob;
  if (!subscribeJob) return;
  if (!opts.inventory.listModules) return;

  for (const mod of opts.inventory.listModules()) {
    const workers = mod.backgroundWorkers;
    if (!workers) continue;
    const slug = mod.manifest.slug;

    for (const [workerName, handler] of Object.entries(workers)) {
      const jobName = `module:${slug}:${workerName}`;
      const workerLogger = opts.logger.child({
        module_slug: slug,
        module_worker: workerName,
      });
      // The structural ModulePackageLike types handler params as `never` (see
      // inventory.ts) purely for assignability; here we invoke it with the real
      // worker ctx + payload, so cast to the actual call shape.
      const invoke = handler as unknown as (
        ctx: {
          settings: unknown;
          logger: typeof workerLogger;
          enqueue: (workerName: string, payload?: unknown) => Promise<void>;
          connector: (capability: string) => Promise<unknown>;
          connectorCredentials: (
            capability: string,
          ) => Promise<{ instanceId: string; providerSlug: string; credentials: unknown }>;
        },
        payload: unknown,
      ) => Promise<void>;
      // Lets a worker chain its own follow-up work (e.g. batched, resumable
      // jobs), routed to module:<slug>:<name> just like the route-context enqueue.
      const enqueue = async (nextWorker: string, payload?: unknown): Promise<void> => {
        const enqueueJob = opts.trigger?.enqueueJob;
        if (!enqueueJob) {
          throw new Error(
            `module ${slug}: ctx.enqueue('${nextWorker}') called but no jobs backend is wired (trigger.enqueueJob missing)`,
          );
        }
        await enqueueJob(`module:${slug}:${nextWorker}`, payload);
      };
      await subscribeJob(jobName, async (payload) => {
        // Resolve settings fresh per job so operator settings changes take
        // effect without a worker restart.
        const settings = await loadModuleSettings(opts.db, mod);
        await invoke(
          {
            settings,
            logger: workerLogger,
            enqueue,
            ...buildModuleConnectorAccess(opts.trigger?.connectors, slug),
          },
          payload,
        );
      });
      opts.logger.info({ module: slug, worker: workerName, jobName }, 'module background worker registered');
    }
  }
}
