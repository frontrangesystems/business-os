import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { settings as settingsTable, type Db } from '@frontrangesystems/business-os-db';
import type { AppDeps } from './app.js';
import type { AgentInventory, ManualTriggerer, ModulePackageLike } from './inventory.js';

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

    const settings = await loadModuleSettings(deps.db, mod);
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
        // Cast through unknown — the module-sdk types `app` as unknown to stay
        // runtime-neutral. Inside this closure it's a normal FastifyInstance.
        await Promise.resolve(
          (mod.registerRoutes as (a: unknown, c: unknown) => void | Promise<void>)(scope, {
            settings,
            logger: childLogger,
            enqueue,
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
        ctx: { settings: unknown; logger: typeof workerLogger },
        payload: unknown,
      ) => Promise<void>;
      await subscribeJob(jobName, async (payload) => {
        // Resolve settings fresh per job so operator settings changes take
        // effect without a worker restart.
        const settings = await loadModuleSettings(opts.db, mod);
        await invoke({ settings, logger: workerLogger }, payload);
      });
      opts.logger.info({ module: slug, worker: workerName, jobName }, 'module background worker registered');
    }
  }
}
