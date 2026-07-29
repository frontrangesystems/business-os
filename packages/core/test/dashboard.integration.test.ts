import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { buildApp, SESSION_COOKIE } from '../src/app.js';
import { createSecretsStore } from '../src/secrets/index.js';
import { createUser } from '../src/auth/users.js';
import type { AgentInventory, ModulePackageLike } from '../src/inventory.js';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';
import { userRoles } from '@frontrangesystems/business-os-db';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[dashboard.integration] Skipping: Postgres unreachable at ${TEST_DATABASE_URL}.`,
  );
}

/**
 * Dashboard aggregation + Status split.
 *
 *  - GET /api/dashboard returns the cards each module contributes, per user,
 *    reading each module's live settings. A module without the hook is skipped;
 *    a module whose hook throws is skipped (one broken module never blanks the
 *    page).
 *  - GET /api/status (former dashboard payload) is admin-only.
 */

// Contributes a card whose item count is driven by its settings — proves the
// hook sees live, default-applied settings and the requesting user.
const contributingModule: ModulePackageLike = {
  manifest: {
    slug: 'alpha',
    version: '0.0.1',
    displayName: 'Alpha',
    description: 'Contributes a dashboard card.',
    settingsSchema: z.object({ count: z.number().int().min(1).max(10).default(3) }),
  },
  dashboardContribution: (async (ctx: {
    user: { id: string; email: string };
    settings: { count: number };
  }) => ({
    title: 'Alpha items',
    summary: `for ${ctx.user.email}`,
    items: Array.from({ length: ctx.settings.count }, (_v, i) => ({
      title: `item ${i + 1}`,
      href: '/modules/alpha',
      badge: `#${i + 1}`,
    })),
    ctaLabel: 'View all',
    ctaHref: '/modules/alpha',
  })) as unknown as ModulePackageLike['dashboardContribution'],
};

// No dashboardContribution — must be absent from the aggregate.
const silentModule: ModulePackageLike = {
  manifest: {
    slug: 'beta',
    version: '0.0.1',
    displayName: 'Beta',
    description: 'No dashboard card.',
    settingsSchema: z.object({}),
  },
};

// Throws — must be skipped without failing the whole request.
const brokenModule: ModulePackageLike = {
  manifest: {
    slug: 'gamma',
    version: '0.0.1',
    displayName: 'Gamma',
    description: 'Broken dashboard card.',
    settingsSchema: z.object({}),
  },
  dashboardContribution: (async () => {
    throw new Error('boom');
  }) as unknown as ModulePackageLike['dashboardContribution'],
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
  listModules: () => [contributingModule, silentModule, brokenModule],
};

async function loginCookie(
  app: ReturnType<typeof buildApp>,
  email: string,
  password: string,
): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  const setCookie = login.headers['set-cookie'];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const m = (header ?? '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return `${SESSION_COOKIE}=${m?.[1]}`;
}

d('dashboard aggregation + status split (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let app: ReturnType<typeof buildApp>;
  let userCookie = '';
  let adminCookie = '';

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
    await app.ready();

    await createUser(env.db, { email: 'user@example.com', password: 'correct-horse-battery-staple' });
    const admin = await createUser(env.db, { email: 'admin@example.com', password: 'correct-horse-battery-staple' });
    await env.db.insert(userRoles).values({ userId: admin.id, role: 'admin' });

    userCookie = await loginCookie(app, 'user@example.com', 'correct-horse-battery-staple');
    adminCookie = await loginCookie(app, 'admin@example.com', 'correct-horse-battery-staple');
  });

  afterAll(async () => {
    await app.close();
    await env.sql.end({ timeout: 1 });
  });

  it('rejects unauthenticated /api/dashboard', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(r.statusCode).toBe(401);
  });

  it('aggregates contributing modules, skips silent + broken ones', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { cookie: userCookie },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { cards: Array<{ moduleSlug: string; title: string; summary: string; items: unknown[]; ctaHref: string }> };
    // Only 'alpha' contributes; 'beta' has no hook, 'gamma' threw.
    expect(body.cards.map((c) => c.moduleSlug)).toEqual(['alpha']);
    const card = body.cards[0];
    expect(card.title).toBe('Alpha items');
    // Per-user: summary carries the requesting user's email.
    expect(card.summary).toBe('for user@example.com');
    // Default settings → 3 items.
    expect(card.items).toHaveLength(3);
    expect(card.ctaHref).toBe('/modules/alpha');
  });

  it('reflects a module settings change on the next load — no restart', async () => {
    await env.sql`
      INSERT INTO settings (scope, value)
      VALUES ('module:alpha', '{"count": 1}'::jsonb)
      ON CONFLICT (scope) DO UPDATE SET value = EXCLUDED.value
    `;
    const r = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { cookie: userCookie },
    });
    const body = r.json() as { cards: Array<{ items: unknown[] }> };
    expect(body.cards[0].items).toHaveLength(1);
  });

  it('GET /api/status is admin-only', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie: userCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie: adminCookie },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { agentCount: number; recentRuns: unknown[]; capabilities: unknown[] };
    expect(body).toHaveProperty('agentCount');
    expect(body).toHaveProperty('recentRuns');
    expect(body).toHaveProperty('capabilities');
  });

  it('GET /api/meta returns the running version (any authenticated user)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/meta',
      headers: { cookie: userCookie },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { version: string };
    // Read from core's own package.json via version.ts — must be a non-empty semver-ish string.
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });
});
