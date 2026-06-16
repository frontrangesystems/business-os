import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import postgres from 'postgres';
import { pino } from 'pino';
import { settings as settingsTable } from '@frontrangesystems/business-os-db';
import { AGENT_REFRESH_CHANNEL } from '@frontrangesystems/business-os-core';
import { Registry } from '../src/registry.js';
import { createConnectorResolver } from '../src/active-connectors.js';
import { Scheduler } from '../src/scheduler.js';
import { createSecretsStore } from '@frontrangesystems/business-os-core/secrets';
import { randomBytes } from 'node:crypto';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[scheduler-refresh.integration] Skipping: Postgres unreachable at ${TEST_DATABASE_URL}.`,
  );
}

/** Poll a predicate until true or timeout. */
async function eventually(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 25 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

d('Scheduler live-refresh via LISTEN/NOTIFY', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let registry: Registry;
  let scheduler: Scheduler;
  let notifier: ReturnType<typeof postgres>;
  const logger = pino({ level: 'silent' });
  const SLUG = 'cron-agent';

  beforeAll(async () => {
    env = await freshDb();
    registry = new Registry();
    registry.registerAgent({
      manifest: {
        slug: SLUG,
        version: '0.0.1',
        displayName: 'Cron',
        description: 't',
        requiredConnectors: [] as const,
        settingsSchema: z.object({}),
        schedule: { kind: 'cron', expr: '0 0 * * *' },
      },
      run: async (_ctx, input) => ({ ok: true, summary: 'ran', details: { input } }),
    });
    const secrets = createSecretsStore(env.db, new Uint8Array(randomBytes(32)));
    const resolver = createConnectorResolver({ db: env.db, secrets, registry, logger });
    // Pass the raw sql client so the scheduler LISTENs for refreshes.
    scheduler = new Scheduler({ db: env.db, sql: env.sql, registry, connectors: resolver, logger });
    await scheduler.start();
    // Second, independent connection — simulates the api (web) process.
    notifier = postgres(TEST_DATABASE_URL, { max: 1 });
  });

  afterAll(async () => {
    await scheduler.stop();
    await notifier.end({ timeout: 1 }).catch(() => {});
    await env.sql.end({ timeout: 1 }).catch(() => {});
  });

  it('does not schedule a DB-disabled agent at start()', () => {
    expect(scheduler._hasCron(SLUG)).toBe(false);
  });

  it('live-schedules the agent when enabled + NOTIFY arrives from another connection', async () => {
    // Enable in the DB (as the enable route would).
    await env.db.insert(settingsTable).values({
      scope: `agent-enabled:${SLUG}`,
      value: { enabled: true },
    });
    // NOTIFY from the *other* connection — cross-process simulation.
    await notifier`select pg_notify(${AGENT_REFRESH_CHANNEL}, ${SLUG})`;

    const scheduled = await eventually(() => scheduler._hasCron(SLUG));
    expect(scheduled).toBe(true);
  });

  it('live-unschedules the agent when disabled + NOTIFY arrives', async () => {
    await env.db
      .insert(settingsTable)
      .values({ scope: `agent-enabled:${SLUG}`, value: { enabled: false } })
      .onConflictDoUpdate({
        target: settingsTable.scope,
        set: { value: { enabled: false } },
      });
    await notifier`select pg_notify(${AGENT_REFRESH_CHANNEL}, ${SLUG})`;

    const unscheduled = await eventually(() => !scheduler._hasCron(SLUG));
    expect(unscheduled).toBe(true);
  });

  it('a NOTIFY for an unknown slug does not throw', async () => {
    await notifier`select pg_notify(${AGENT_REFRESH_CHANNEL}, ${'no-such-agent'})`;
    // Give the listener a tick to process; nothing should blow up.
    await new Promise((r) => setTimeout(r, 100));
    expect(scheduler._hasCron('no-such-agent')).toBe(false);
  });
});
