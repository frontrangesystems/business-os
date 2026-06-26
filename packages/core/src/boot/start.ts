import {
  agentRuns,
  createDb,
  runMigrations,
  coreMigrations,
  settings as settingsTable,
  type MigrationOwner,
} from '@frontrangesystems/business-os-db';
import { sql as sqlOp } from 'drizzle-orm';
import { pino, type Logger } from 'pino';
import { buildApp, type AppDeps } from '../app.js';
import { registerModuleRoutes, registerModuleBackgroundWorkers } from '../modules.js';
import { createSecretsStore, loadSecretsKey } from '../secrets/index.js';
import { parseEnv, type FrameworkEnv } from './env.js';
import type {
  AgentInventory,
  ManualTriggerer,
  ExternalOAuthBrokerLike,
} from '../inventory.js';

/**
 * The framework's entry point. A client shell's index.ts does:
 *
 *   import { startServer } from '@frontrangesystems/business-os-core';
 *   import { Registry, Scheduler, createConnectorResolver } from '@frontrangesystems/business-os-runtime';
 *   import leadgen from '@frontrangesystems/business-os-agent-leadgen';
 *   import anthropic from '@frontrangesystems/business-os-connector-anthropic';
 *
 *   const registry = new Registry();
 *   registry.registerAgent(leadgen);
 *   registry.registerConnectorProvider(anthropic);
 *
 *   await startServer({
 *     env: process.env,
 *     inventory: registry,
 *     mode: process.argv.includes('--worker') ? 'worker' : 'api',
 *     // Optional: a function that returns a Scheduler-like trigger. We can't
 *     // import @frontrangesystems/business-os-runtime here without creating a cycle, so the
 *     // client constructs it and passes it in.
 *     trigger: (deps) => makeScheduler(deps),
 *     // Optional: agents and connectors may ship their own migration owners.
 *     migrations: [...leadgen.migrations, ...anthropic.migrations],
 *   });
 *
 * Modes:
 *   - 'api'    : Fastify listens on API_PORT. Scheduler is NOT started.
 *   - 'worker' : Scheduler is started; no HTTP listener. Use for the
 *                background-job process.
 *   - 'both'   : Single-process dev convenience — Fastify + Scheduler.
 */

export type StartMode = 'api' | 'worker' | 'both';

export interface StartServerOpts {
  /** Process env. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Inventory of registered agents + connector providers. */
  inventory: AgentInventory;
  /**
   * Optional trigger factory. The runtime's Scheduler implements this; if
   * omitted, manual-run endpoints return 503.
   */
  triggerFactory?: (deps: { startScheduler: boolean }) => ManualTriggerer & {
    start?: () => void;
    stop?: () => Promise<void>;
  };
  /**
   * Extra migration owners contributed by agents + connectors. The framework's
   * coreMigrations are always run first.
   */
  migrations?: MigrationOwner[];
  /**
   * 'api' | 'worker' | 'both'. Default: 'both' in development, 'api' otherwise.
   */
  mode?: StartMode;
  /** Override the issuer label shown in TOTP enrollment. */
  issuer?: string;
  /**
   * External OAuth brokers (Composio etc). The client shell constructs the
   * concrete broker with its API key + passes it here. Currently only
   * 'composio' is wired; future providers go in the same map.
   *
   * Kept for backward compat. New installs should use
   * `externalOAuthBrokerFactories` instead — the key is stored in the DB
   * and the broker is constructed lazily at OAuth flow time.
   */
  externalOAuthBrokers?: {
    composio?: ExternalOAuthBrokerLike;
  };
  /**
   * Broker factories keyed by provider name. When provided, `startServer`
   * constructs a lazy `getExternalOAuthBroker` resolver that reads the API
   * key from the DB secrets store at OAuth flow time and passes it to the
   * factory. The key must be saved by the operator via the settings UI
   * (`PUT /api/platform/composio`).
   *
   * The factory receives the decrypted API key and must return a broker
   * implementing `ExternalOAuthBrokerLike`. Core cannot import the concrete
   * broker class (that would violate the framework → connector boundary), so
   * the client shell provides the constructor here.
   *
   * Example:
   *   externalOAuthBrokerFactories: {
   *     composio: (apiKey) => new ComposioSubstrate({ apiKey }),
   *   }
   */
  externalOAuthBrokerFactories?: {
    composio?: (apiKey: string) => ExternalOAuthBrokerLike;
  };
  /**
   * Public URL of this install. Used to build OAuth callback URLs the broker
   * redirects back to. Falls back to env PUBLIC_URL, then to the request's
   * Host header.
   */
  publicUrl?: string;
  /** Override AppDeps (escape hatch for tests). Don't use in production. */
  overrideAppDeps?: Partial<AppDeps>;
}

export interface StartedServer {
  env: FrameworkEnv;
  url?: string;
  /** Returns when the process should exit. Idempotent. */
  shutdown: () => Promise<void>;
}

export async function startServer(opts: StartServerOpts): Promise<StartedServer> {
  const env = parseEnv(opts.env);
  const mode: StartMode = opts.mode ?? (env.NODE_ENV === 'development' ? 'both' : 'api');

  // Boot/worker-process structured logger. The API process logs through
  // Fastify's request-scoped `req.log`; everything that happens outside a
  // request (migrations, brownfield seed, worker registration, worker-only
  // mode) logs here. Pre-tagged with client_slug so every boot line matches the
  // convention; child loggers add module_slug etc.
  const log = pino({
    level: env.LOG_LEVEL,
    base: { client_slug: env.CLIENT_SLUG },
  });

  const { db, sql } = createDb({ url: env.DATABASE_URL });

  // Module migration owners discovered from the inventory — each registered
  // module that ships migrationsDir contributes its own owner alongside
  // anything passed in opts.migrations.
  const moduleOwners: MigrationOwner[] = [];
  if (opts.inventory.listModules) {
    for (const mod of opts.inventory.listModules()) {
      if (mod.manifest.migrationsDir) {
        moduleOwners.push({
          // Internal migration tracking string — see packages/db/src/owners.ts.
          owner: `@business-os/module-${mod.manifest.slug}`,
          dir: mod.manifest.migrationsDir,
        });
      }
    }
  }

  const owners: MigrationOwner[] = [
    coreMigrations,
    ...moduleOwners,
    ...(opts.migrations ?? []),
  ];
  const applied = await runMigrations(sql, owners);
  if (applied.applied.length > 0) {
    log.info(
      {
        count: applied.applied.length,
        migrations: applied.applied.map((a) => `${a.owner}/${a.name}`),
      },
      'migrations.applied',
    );
  }

  const encryptionKey = loadSecretsKey({ SECRETS_KEY: env.SECRETS_KEY });
  const secrets = createSecretsStore(db, encryptionKey);

  // Brownfield-safe seed: if this install has prior agent runs but no
  // `agent-enabled:*` rows, it predates the Add Agent flow — enable every
  // currently-registered agent so the upgrade doesn't silently disable
  // everything. Fresh installs (no runs, no enable rows) skip this and the
  // operator picks via Add Agent. Idempotent via a meta sentinel.
  if (opts.inventory) {
    await seedAgentEnabledIfNeeded(db, opts.inventory, log);
  }

  // Lazy broker resolver: reads the API key from the DB secrets store at
  // OAuth flow time, then hands it to the client-provided factory. This lets
  // the operator configure the key via the settings UI without restarting.
  // Static externalOAuthBrokers still work for backward compat and take
  // precedence over the factory.
  let getExternalOAuthBroker: ((provider: string) => Promise<ExternalOAuthBrokerLike | null>) | undefined;
  const factories = opts.externalOAuthBrokerFactories ?? {};
  const staticBrokers = opts.externalOAuthBrokers ?? {};
  // Warn at boot if static broker will shadow the factory — operator setting the key via the
  // settings UI will appear to succeed but the static broker will always be used instead.
  for (const provider of Object.keys(factories)) {
    if (staticBrokers[provider as keyof typeof staticBrokers]) {
      log.warn(
        { provider },
        `externalOAuthBrokerFactories.${provider} is registered but externalOAuthBrokers.${provider} takes precedence — key set via the settings UI will be ignored. Remove externalOAuthBrokers.${provider} from startServer() to enable the DB-backed factory.`,
      );
    }
  }
  if (Object.keys(factories).length > 0 || Object.keys(staticBrokers).length > 0) {
    getExternalOAuthBroker = async (provider: string) => {
      // Static broker takes precedence (backward compat with existing deploys).
      const staticBroker = staticBrokers[provider as keyof typeof staticBrokers];
      if (staticBroker) return staticBroker;
      // Factory path: read key from DB, construct broker on demand.
      const factory = factories[provider as keyof typeof factories];
      if (!factory) return null;
      const apiKey = await secrets.get(`platform:${provider}`, 'api_key');
      if (!apiKey) return null;
      return factory(apiKey);
    };
  }

  const trigger = opts.triggerFactory?.({
    startScheduler: mode === 'worker' || mode === 'both',
  });
  // Start the trigger in EVERY mode. The trigger was handed `startScheduler`
  // and decides what to bring up: worker/both start the scheduler + full jobs
  // (consumers running); api-only connects the jobs backend enqueue-only so
  // module routes can enqueue background work without running consumers. A
  // trigger that doesn't need an api-mode connection can simply no-op when
  // startScheduler is false (older triggers did, and still work).
  if (trigger?.start) {
    trigger.start();
  }

  // Worker (and dev `both`) process: attach every module's background workers
  // to the jobs backend. They run as `module:<slug>:<name>` jobs triggered by
  // the module's own ctx.enqueue — never as agents (no registry entry, no
  // Agents-list row, no enable bit). No-op if the trigger doesn't expose a
  // jobs backend (subscribeJob). In api-only mode we skip this entirely so the
  // API process never runs consumers (it only enqueues).
  if ((mode === 'worker' || mode === 'both') && trigger) {
    const workerLogger = log;
    try {
      await registerModuleBackgroundWorkers({
        db,
        inventory: opts.inventory,
        trigger,
        logger: workerLogger,
      });
    } catch (err) {
      workerLogger.warn({ err }, 'module background worker registration failed');
    }
  }

  // API process
  let url: string | undefined;
  const app =
    mode === 'worker'
      ? undefined
      : buildApp({
          db,
          secrets,
          encryptionKey,
          clientSlug: env.CLIENT_SLUG,
          issuer: opts.issuer ?? env.CLIENT_NAME,
          cookieSecure: env.NODE_ENV === 'production',
          inventory: opts.inventory,
          trigger,
          externalOAuthBrokers: opts.externalOAuthBrokers,
          getExternalOAuthBroker,
          publicUrl: opts.publicUrl ?? opts.env?.PUBLIC_URL,
          ...opts.overrideAppDeps,
        });
  if (app) {
    // Module routes must register before app.listen — Fastify's ready phase
    // bakes the route table at listen time. The deps closed over the app are
    // the same object we passed to buildApp; reuse it here so module-sdk's
    // registerRoutes sees fully-wired db + logger.
    const appDeps = (app as unknown as { deps?: AppDeps }).deps ?? null;
    if (appDeps) {
      try {
        await registerModuleRoutes(app, appDeps);
      } catch (err) {
        app.log.warn({ err }, 'module route registration failed');
      }
    }
    await app.listen({ host: '0.0.0.0', port: env.API_PORT });
    url = `http://0.0.0.0:${env.API_PORT}`;
    app.log.info({ mode, port: env.API_PORT }, 'business-os: api listening');
  } else {
    log.info({ mode }, 'worker-only mode; scheduler running');
  }

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (app) await app.close().catch(() => {});
    if (trigger?.stop) await trigger.stop().catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
  };

  return { env, url, shutdown };
}

const AGENT_SEED_MARKER_SCOPE = 'meta:agent-enabled-seeded';

/**
 * One-time bootstrap: if the install has prior agent runs but no
 * `agent-enabled:*` rows AND we haven't already seeded, enable every
 * currently-registered agent. Preserves behavior for installs that predate
 * the Add Agent flow. Fresh installs (no runs) skip the seed and start
 * with everything disabled — operator picks via the UI.
 */
async function seedAgentEnabledIfNeeded(
  db: ReturnType<typeof createDb>['db'],
  inventory: AgentInventory,
  log: Logger,
): Promise<void> {
  // Idempotent: once we set the marker, never seed again, even if an operator
  // disables everything and the system ends up looking like a fresh install.
  const marker = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(sqlOp`${settingsTable.scope} = ${AGENT_SEED_MARKER_SCOPE}`)
    .limit(1);
  if (marker.length > 0) return;

  // Fresh install = no agent_runs rows. Skip the seed entirely; operator picks.
  const runsCheck = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .limit(1);
  if (runsCheck.length === 0) {
    await db
      .insert(settingsTable)
      .values({ scope: AGENT_SEED_MARKER_SCOPE, value: { at: new Date().toISOString(), seeded: 0 } })
      .onConflictDoNothing();
    return;
  }

  // Brownfield: enable every registered agent + mark as seeded.
  const slugs = inventory.listAgents().map((a) => a.manifest.slug);
  for (const slug of slugs) {
    await db
      .insert(settingsTable)
      .values({ scope: `agent-enabled:${slug}`, value: { enabled: true } })
      .onConflictDoNothing();
  }
  await db
    .insert(settingsTable)
    .values({
      scope: AGENT_SEED_MARKER_SCOPE,
      value: { at: new Date().toISOString(), seeded: slugs.length },
    })
    .onConflictDoNothing();
  log.info({ count: slugs.length }, 'agent.brownfield_enabled');
}
