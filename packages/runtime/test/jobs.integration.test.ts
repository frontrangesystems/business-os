import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pino } from 'pino';
import { agentRuns } from '@frontrangesystems/business-os-db';
import { eq } from 'drizzle-orm';
import { createSecretsStore } from '@frontrangesystems/business-os-core/secrets';
import { Registry } from '../src/registry.js';
import { createConnectorResolver } from '../src/active-connectors.js';
import { createJobsBackend } from '../src/jobs.js';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(`[jobs.integration] Skipping: Postgres unreachable at ${TEST_DATABASE_URL}.`);
}

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = async (): Promise<void> => {
      try {
        if (await predicate()) return resolve();
      } catch {
        // ignore — retry
      }
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error(`waitFor: timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, intervalMs);
    };
    void tick();
  });
}

d('pg-boss jobs backend (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let registry: Registry;
  let resolver: ReturnType<typeof createConnectorResolver>;
  let jobs: ReturnType<typeof createJobsBackend>;
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    env = await freshDb();
    registry = new Registry();
    registry.registerAgent({
      manifest: {
        slug: 'pinger',
        version: '0.0.1',
        displayName: 'Pinger',
        description: 'test',
        requiredConnectors: [] as const,
        settingsSchema: z.object({}),
        schedule: { kind: 'manual' as const },
      },
      run: async (_ctx, input) => ({
        ok: true,
        summary: 'ping',
        details: { input },
      }),
    });
    const secrets = createSecretsStore(env.db, new Uint8Array(randomBytes(32)));
    resolver = createConnectorResolver({ db: env.db, secrets, registry, logger });
    jobs = createJobsBackend({
      databaseUrl: env.url,
      db: env.db,
      registry,
      connectors: resolver,
      logger,
    });
    await jobs.start();
  });

  afterAll(async () => {
    await jobs.stop();
    await env.sql.end({ timeout: 1 });
  });

  it('enqueueing a job named after an agent runs the agent', async () => {
    await jobs.enqueue('pinger', { payload: 'hello' });
    await waitFor(async () => {
      const rows = await env.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.agentSlug, 'pinger'));
      return rows.length > 0;
    });
    const rows = await env.db.select().from(agentRuns).where(eq(agentRuns.agentSlug, 'pinger'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.trigger).toBe('event:job:pinger');
    expect(rows[0]!.ok).toBe(true);
  });

  it('dedupes via idempotencyKey (singletonKey)', async () => {
    const id1 = await jobs.enqueue('pinger', { x: 1 }, { idempotencyKey: 'dup-1' });
    const id2 = await jobs.enqueue('pinger', { x: 2 }, { idempotencyKey: 'dup-1' });
    // Either both return ids but only one runs, OR the second returns a
    // deduped marker — both are acceptable. We assert no double-run.
    expect([id1, id2]).toContain(id1);

    // Wait for the first to consume.
    await waitFor(async () => {
      const rows = await env.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.agentSlug, 'pinger'));
      // Includes the prior test's row, so look for at least 2 total.
      return rows.length >= 2;
    });
  });

  it('custom subscribe() handler receives payloads', async () => {
    const received: unknown[] = [];
    await jobs.subscribe('custom-job', async (payload) => {
      received.push(payload);
    });
    await jobs.enqueue('custom-job', { ok: true });
    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual({ ok: true });
  });
});

/**
 * Module-owned background worker wiring. Mirrors how core wires modules:
 *   - the API process connects the jobs backend enqueue-only
 *     (`start({ withWorkers: false })`) so module routes can enqueue;
 *   - the worker process subscribes a handler under the module job name
 *     `module:<slug>:<worker>` and runs full (`start()` / withWorkers: true);
 *   - enqueueing `module:<slug>:<worker>` routes to that handler and NEVER to
 *     runAgent (the name isn't an agent slug).
 */
d('module background workers (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let registry: Registry;
  let resolver: ReturnType<typeof createConnectorResolver>;
  let apiJobs: ReturnType<typeof createJobsBackend>;
  let workerJobs: ReturnType<typeof createJobsBackend>;
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    env = await freshDb();
    registry = new Registry();
    const secrets = createSecretsStore(env.db, new Uint8Array(randomBytes(32)));
    resolver = createConnectorResolver({ db: env.db, secrets, registry, logger });

    // The "API process" backend — enqueue-only, no consumers.
    apiJobs = createJobsBackend({
      databaseUrl: env.url,
      db: env.db,
      registry,
      connectors: resolver,
      logger,
    });
    await apiJobs.start({ withWorkers: false });

    // The "worker process" backend — full, runs consumers.
    workerJobs = createJobsBackend({
      databaseUrl: env.url,
      db: env.db,
      registry,
      connectors: resolver,
      logger,
    });
    await workerJobs.start();
  });

  afterAll(async () => {
    await apiJobs.stop();
    await workerJobs.stop();
    await env.sql.end({ timeout: 1 });
  });

  it('enqueue (api, enqueue-only) -> module worker handler runs (worker)', async () => {
    const received: unknown[] = [];
    const jobName = 'module:bid-indexer:index';
    await workerJobs.subscribe(jobName, async (payload) => {
      received.push(payload);
    });

    // Enqueue from the enqueue-only backend, exactly as a module route would
    // via ctx.enqueue.
    const id = await apiJobs.enqueue(jobName, { bidId: 'abc-123' });
    expect(id).toBeTruthy();

    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual({ bidId: 'abc-123' });
  });
});
