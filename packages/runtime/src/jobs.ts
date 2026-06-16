import PgBoss from 'pg-boss';
import type { Logger } from 'pino';
import type { EnqueueOpts } from '@frontrangesystems/business-os-agent-sdk';
import type { Registry } from './registry.js';
import type { ConnectorResolver } from './active-connectors.js';
import { runAgent } from './run.js';
import type { Db } from '@frontrangesystems/business-os-db';

/**
 * Durable background jobs.
 *
 * Per CLAUDE.md: "Background jobs: pg-boss in the client's DB. Worker is the
 * same binary as the API with --worker flag."
 *
 * Two routing modes for enqueued jobs:
 *
 *   1. Job name === an agent slug: handled by runAgent() on the worker.
 *      `await ctx.jobs.enqueue('leadgen', { seed: 'concrete contractors' })`
 *      The agent shows up in agent_runs with trigger="event:job:<name>".
 *
 *   2. Job name is anything else: routed to a custom handler the client shell
 *      may have registered via `jobs.subscribe(name, handler)`. Useful for
 *      ad-hoc periodic work the operator doesn't want as a full agent yet.
 *
 * Either way: pg-boss persists the job, retries on failure (per pg-boss
 * defaults), supports delayed dispatch via `opts.delayMs`, and supports
 * idempotency via `opts.idempotencyKey` (mapped to pg-boss's singletonKey).
 */

export interface JobsBackend {
  /** Enqueue a named job with payload. */
  enqueue(name: string, payload: unknown, opts?: EnqueueOpts): Promise<string>;
  /** Register a custom job handler (non-agent names only). */
  subscribe(
    name: string,
    handler: (payload: unknown) => Promise<void>,
  ): Promise<void>;
  /**
   * Connect pg-boss and (by default) register consumers.
   *
   *   - `start()` / `start({ withWorkers: true })` — full behavior: connect +
   *     register agent-routing workers + custom subscribers + begin processing.
   *     Use in the worker (and `both`) process.
   *   - `start({ withWorkers: false })` — connect ONLY (enqueue-only). pg-boss
   *     requires `.start()` before `.send()`, so the API process calls this so
   *     `enqueue` works without registering any consumers. No agent/custom
   *     handlers run in this process.
   *
   * Idempotent: once started in either form, repeat calls are no-ops. A later
   * `subscribe()` after a `withWorkers: false` start does NOT begin consuming
   * (the process opted out of workers); it's recorded for a future full start.
   */
  start(opts?: { withWorkers?: boolean }): Promise<void>;
  /** Stop consumers and close the pg-boss connection. */
  stop(): Promise<void>;
}

export interface JobsDeps {
  /** Postgres connection string. pg-boss creates its own pool. */
  databaseUrl: string;
  db: Db;
  registry: Registry;
  connectors: ConnectorResolver;
  logger: Logger;
}

export function createJobsBackend(deps: JobsDeps): JobsBackend {
  const boss = new PgBoss({
    connectionString: deps.databaseUrl,
    // pg-boss creates its own schema (`pgboss`) — keeps it cleanly separated
    // from the framework's `public` schema.
  });

  // Custom (non-agent) handlers registered by the client shell.
  const customHandlers = new Map<string, (payload: unknown) => Promise<void>>();
  let started = false;
  // True once consumers (agent-routing + custom subscribers) are registered.
  // An enqueue-only start connects pg-boss but leaves this false.
  let workersRegistered = false;

  async function registerAllWorkers(): Promise<void> {
    // Register agent-routing worker for every agent slug in the registry.
    for (const agent of deps.registry.listAgents()) {
      const slug = agent.manifest.slug;
      await boss.work<unknown>(slug, async (jobs) => {
        for (const job of jobs) {
          await runAgent(
            {
              db: deps.db,
              registry: deps.registry,
              connectors: deps.connectors,
              logger: deps.logger,
            },
            slug,
            job.data,
            { kind: 'event', detail: `job:${slug}` },
          );
        }
      });
    }
    for (const [name, handler] of customHandlers) {
      await registerCustomHandler(boss, name, handler);
    }
    workersRegistered = true;
    deps.logger.info(
      { customHandlers: customHandlers.size, agentWorkers: deps.registry.listAgents().length },
      'jobs.started',
    );
  }

  return {
    async enqueue(name, payload, opts): Promise<string> {
      // Auto-connect enqueue-only if nobody started us yet — never implicitly
      // register workers from inside an enqueue.
      if (!started) await this.start({ withWorkers: false });
      const sendOpts: PgBoss.SendOptions = {};
      if (opts?.delayMs && opts.delayMs > 0) {
        sendOpts.startAfter = Math.ceil(opts.delayMs / 1000);
      }
      if (opts?.idempotencyKey) {
        sendOpts.singletonKey = opts.idempotencyKey;
      }
      const id = await boss.send(name, payload as object, sendOpts);
      if (!id) {
        // pg-boss returns null when a singletonKey collides with an existing job.
        deps.logger.info(
          { name, idempotencyKey: opts?.idempotencyKey },
          'jobs.enqueue.deduped',
        );
        return `deduped:${opts?.idempotencyKey ?? ''}`;
      }
      return id;
    },

    async subscribe(name, handler): Promise<void> {
      customHandlers.set(name, handler);
      if (workersRegistered) {
        // Late subscription on a worker process — register immediately.
        await registerCustomHandler(boss, name, handler);
      }
    },

    async start(opts): Promise<void> {
      const withWorkers = opts?.withWorkers ?? true;
      if (started) {
        // Already connected. If a prior enqueue-only start brought us up and a
        // caller now wants full workers, register them on top of the live
        // connection. (The reverse — downgrading to enqueue-only — is a no-op.)
        if (withWorkers && !workersRegistered) await registerAllWorkers();
        return;
      }
      await boss.start();
      started = true;
      if (withWorkers) await registerAllWorkers();
    },

    async stop(): Promise<void> {
      if (!started) return;
      await boss.stop({ graceful: true });
      started = false;
      workersRegistered = false;
    },
  };
}

async function registerCustomHandler(
  boss: PgBoss,
  name: string,
  handler: (payload: unknown) => Promise<void>,
): Promise<void> {
  await boss.work<unknown>(name, async (jobs) => {
    for (const job of jobs) {
      await handler(job.data);
    }
  });
}
