import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { registerModuleRoutes } from '../src/modules.js';
import { createSecretsStore } from '../src/secrets/index.js';
import type { AgentInventory, ModulePackageLike } from '../src/inventory.js';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[core.integration] Skipping: Postgres unreachable at ${TEST_DATABASE_URL}. ` +
      `Start it with \`docker compose up -d postgres\` to run these tests.`,
  );
}

/**
 * Module route handlers must see settings changes made in the settings UI
 * WITHOUT a process restart — same rule as module background workers, which
 * resolve settings fresh per job. Regression test for the boot-time-snapshot
 * bug found 2026-07-10 (operator lowered Prospector's minDashboardScore and
 * the dashboard didn't change until the API machine was restarted).
 */

const fakeModule: ModulePackageLike = {
  manifest: {
    slug: 'fake-settings-probe',
    version: '0.0.1',
    displayName: 'Fake Settings Probe',
    description: 'Test module that echoes its current settings.',
    settingsSchema: z.object({ threshold: z.number().default(60) }),
  },
  registerRoutes(app, ctx) {
    const f = app as {
      get: (path: string, handler: () => unknown) => void;
    };
    const c = ctx as { settings: { threshold: number } };
    f.get('/threshold', () => ({ threshold: c.settings.threshold }));
    // Spread + serialize paths must also see live values (modules do
    // `{ ...ctx.settings }` and JSON.stringify in digest payloads).
    f.get('/threshold-spread', () => ({ ...c.settings }));
  },
};

const inventory: AgentInventory = {
  listAgents: () => [],
  getAgent: () => {
    throw new Error('no agents in this test');
  },
  listConnectorProviders: () => [],
  getConnectorProvider: () => {
    throw new Error('no connectors in this test');
  },
  listModules: () => [fakeModule],
};

d('module route settings are live (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    env = await freshDb();
    const encryptionKey = new Uint8Array(randomBytes(32));
    app = buildApp({
      db: env.db,
      secrets: createSecretsStore(env.db, encryptionKey),
      encryptionKey,
      clientSlug: 'test',
      logger: false,
      serveUi: false,
      inventory,
    });
    await registerModuleRoutes(app, app.deps);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await env.sql.end({ timeout: 1 });
  });

  it('serves schema defaults when no settings row exists', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/modules/fake-settings-probe/threshold',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ threshold: 60 });
  });

  it('reflects a settings change on the next request — no restart', async () => {
    await env.sql`
      INSERT INTO settings (scope, value)
      VALUES ('module:fake-settings-probe', '{"threshold": 40}'::jsonb)
      ON CONFLICT (scope) DO UPDATE SET value = EXCLUDED.value
    `;
    const r = await app.inject({
      method: 'GET',
      url: '/api/modules/fake-settings-probe/threshold',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ threshold: 40 });

    const spread = await app.inject({
      method: 'GET',
      url: '/api/modules/fake-settings-probe/threshold-spread',
    });
    expect(spread.json()).toEqual({ threshold: 40 });
  });
});
