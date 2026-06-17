import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { buildApp, SESSION_COOKIE } from '../src/app.js';
import { createSecretsStore } from '../src/secrets/index.js';
import { createUser } from '../src/auth/users.js';
import type {
  AgentInventory,
  ManualTriggerer,
  ExternalOAuthBrokerLike,
} from '../src/inventory.js';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';
import { settings, userRoles } from '@frontrangesystems/business-os-db';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[admin.integration] Skipping: Postgres unreachable at ${TEST_DATABASE_URL}.`,
  );
}

/**
 * Hand-rolled fake registry that satisfies AgentInventory structurally.
 * Used here so this test doesn't depend on @frontrangesystems/business-os-runtime (the
 * Registry is itself integration-tested in runtime/test).
 */
function fakeInventory(): AgentInventory {
  const agentManifest = {
    slug: 'leadgen',
    version: '0.1.0',
    displayName: 'Lead Generation',
    description: 'finds prospects',
    requiredConnectors: ['email', 'llm'] as const,
    settingsSchema: z.object({
      icp: z.string().min(1),
      maxPerRun: z.number().int().positive().default(25),
    }),
    schedule: { kind: 'manual' as const },
  };
  const llmProviderManifest = {
    slug: 'anthropic',
    capability: 'llm',
    version: '0.1.0',
    displayName: 'Anthropic',
    authKind: 'api-key' as const,
    settingsSchema: z.object({
      defaultModel: z.string().default('claude-opus-4-7'),
    }),
  };
  const emailProviderManifest = {
    slug: 'gmail',
    capability: 'email',
    version: '0.1.0',
    displayName: 'Gmail',
    authKind: 'oauth2' as const,
    settingsSchema: z.object({}),
  };
  /**
   * Composio-backed Gmail provider — same capability as 'gmail' above, but
   * its externalOAuth field tells the framework to drive the Connect flow
   * via the broker instead of asking the operator to paste credentials.
   */
  const gmailComposioManifest = {
    slug: 'email-gmail-composio',
    capability: 'email',
    version: '0.1.0',
    displayName: 'Gmail (via Composio)',
    authKind: 'api-key' as const,
    externalOAuth: { provider: 'composio' as const, toolkit: 'gmail' },
    settingsSchema: z.object({}),
  };

  return {
    listAgents: () => [{ manifest: agentManifest }],
    getAgent: (slug: string) => {
      if (slug !== 'leadgen') throw new Error('not found');
      return { manifest: agentManifest };
    },
    listConnectorProviders: (cap: string) => {
      if (cap === 'llm') return [{ manifest: llmProviderManifest, capability: 'llm' }];
      if (cap === 'email')
        return [
          { manifest: emailProviderManifest, capability: 'email' },
          { manifest: gmailComposioManifest, capability: 'email' },
        ];
      return [];
    },
    getConnectorProvider: (cap: string, slug: string) => {
      if (cap === 'llm' && slug === 'anthropic')
        return { manifest: llmProviderManifest, capability: 'llm' };
      if (cap === 'email' && slug === 'gmail')
        return { manifest: emailProviderManifest, capability: 'email' };
      if (cap === 'email' && slug === 'email-gmail-composio')
        return { manifest: gmailComposioManifest, capability: 'email' };
      throw new Error('not found');
    },
  };
}

/**
 * Test-controllable Composio broker stand-in. Tracks calls + lets each test
 * decide what getActiveConnection should return (null = still pending).
 */
function fakeBroker(): ExternalOAuthBrokerLike & {
  calls: { findOrCreate: string[]; createLink: unknown[]; getActive: unknown[] };
  setActive: (id: string | null) => void;
} {
  const calls = { findOrCreate: [] as string[], createLink: [] as unknown[], getActive: [] as unknown[] };
  let activeConnectionId: string | null = null;
  return {
    calls,
    setActive: (id) => { activeConnectionId = id; },
    findOrCreateManagedAuthConfig: async (toolkit) => {
      calls.findOrCreate.push(toolkit);
      return { id: `ac_${toolkit}`, toolkit };
    },
    createConnectionLink: async (p) => {
      calls.createLink.push(p);
      return { connectionRequestId: 'cr_1', redirectUrl: `https://composio/lk_${p.userId}` };
    },
    getActiveConnection: async (userId, toolkit) => {
      calls.getActive.push({ userId, toolkit });
      return activeConnectionId;
    },
  };
}

d('admin/operator API (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let app: ReturnType<typeof buildApp>;
  const triggered: Array<{ slug: string; input: unknown; userId: string }> = [];
  const encryptionKey = new Uint8Array(randomBytes(32));
  let cookie = '';
  const broker = fakeBroker();

  const trigger: ManualTriggerer = {
    triggerManual: async (slug, input, userId) => {
      triggered.push({ slug, input, userId });
    },
  };

  beforeAll(async () => {
    env = await freshDb();
    const secrets = createSecretsStore(env.db, encryptionKey);
    process.env.COMPOSIO_API_KEY = 'composio-test-key';
    app = buildApp({
      db: env.db,
      secrets,
      encryptionKey,
      clientSlug: 'test',
      logger: false,
      serveUi: false,
      inventory: fakeInventory(),
      trigger,
      externalOAuthBrokers: { composio: broker },
    });
    await app.ready();
    const op = await createUser(env.db, {
      email: 'op@example.com',
      password: 'correct-horse-battery-staple',
    });
    // Admin-write routes are now requireRole('admin')-gated — grant the test
    // operator the admin role so the write-path assertions below still pass.
    await env.db.insert(userRoles).values({ userId: op.id, role: 'admin' });
    // Log in once and reuse the cookie across tests.
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'op@example.com', password: 'correct-horse-battery-staple' },
    });
    const setCookie = login.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const m = (header ?? '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    cookie = `${SESSION_COOKIE}=${m?.[1]}`;
    // Add Agent flow now gates /api/agents — operator has to install before
    // it shows up. Seed leadgen as enabled so tests written against the
    // pre-flow shape still see it.
    await env.db
      .insert(settings)
      .values({ scope: 'agent-enabled:leadgen', value: { enabled: true } })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await app.close();
    await env.sql.end({ timeout: 1 });
  });

  it('rejects unauthenticated /api/agents', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(r.statusCode).toBe(401);
  });

  it('lists registered agents (including a null lastRun before any runs)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/agents',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].slug).toBe('leadgen');
    expect(body.agents[0].lastRun).toBeNull();
    expect(body.agents[0].requiredConnectors).toEqual(['email', 'llm']);
  });

  it('returns 404 for unknown agent slug', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/agents/nope',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(404);
  });

  it('round-trips agent settings via PUT then GET (and validates schema)', async () => {
    // Invalid: missing required `icp`
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/agents/leadgen/settings',
      headers: { cookie },
      payload: { value: { maxPerRun: 10 } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('settings_schema_violation');

    const ok = await app.inject({
      method: 'PUT',
      url: '/api/agents/leadgen/settings',
      headers: { cookie },
      payload: { value: { icp: 'concrete contractors $5M+', maxPerRun: 10 } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.icp).toBe('concrete contractors $5M+');

    const get = await app.inject({
      method: 'GET',
      url: '/api/agents/leadgen',
      headers: { cookie },
    });
    expect(get.json().settings.icp).toBe('concrete contractors $5M+');
    expect(get.json().settings.maxPerRun).toBe(10);
  });

  it('POST /api/agents/:slug/run dispatches via trigger and audits', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/agents/leadgen/run',
      headers: { cookie },
      payload: { input: { batch: 1 } },
    });
    expect(r.statusCode).toBe(200);
    expect(triggered.at(-1)?.slug).toBe('leadgen');
    expect(triggered.at(-1)?.input).toEqual({ batch: 1 });
  });

  it('GET /api/connectors returns capabilities + registered providers', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const llm = body.capabilities.find((c: { capability: string }) => c.capability === 'llm');
    expect(llm.providers.map((p: { slug: string }) => p.slug)).toContain('anthropic');
    expect(llm.instances).toEqual([]);
  });

  it('connector lifecycle: create → set credentials → activate → cascade delete', async () => {
    // Create
    const create = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: { cookie },
      payload: {
        capability: 'llm',
        providerSlug: 'anthropic',
        displayName: 'Anthropic (C&M)',
      },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json().instance.id;
    expect(create.json().instance.isActive).toBe(false);

    // Set credentials (encrypted at rest)
    const creds = await app.inject({
      method: 'PUT',
      url: `/api/connectors/${id}/credentials`,
      headers: { cookie },
      payload: { credentials: { apiKey: 'sk-ant-test' } },
    });
    expect(creds.statusCode).toBe(200);

    // Activate + set settings
    const update = await app.inject({
      method: 'PATCH',
      url: `/api/connectors/${id}`,
      headers: { cookie },
      payload: {
        isActive: true,
        settings: { defaultModel: 'claude-opus-4-7' },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().instance.isActive).toBe(true);

    // Verify there's exactly one active LLM instance (the one we just activated).
    const list = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: { cookie },
    });
    const llmCap = list.json().capabilities.find((c: { capability: string }) => c.capability === 'llm');
    const active = llmCap.instances.filter((i: { isActive: boolean }) => i.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(id);

    // Bad settings rejected
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/connectors/${id}`,
      headers: { cookie },
      payload: { settings: { defaultModel: 123 } },
    });
    expect(bad.statusCode).toBe(400);

    // Delete cascades settings + secrets
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/connectors/${id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: { cookie },
    });
    const llmCapAfter = after.json().capabilities.find((c: { capability: string }) => c.capability === 'llm');
    expect(llmCapAfter.instances.find((i: { id: string }) => i.id === id)).toBeUndefined();
  });

  it('external-OAuth connect flow: initiate → pending → finalize persists creds + activates', async () => {
    // Create a Composio-backed Gmail instance.
    const create = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: { cookie },
      payload: {
        capability: 'email',
        providerSlug: 'email-gmail-composio',
        displayName: 'Gmail (matt)',
      },
    });
    expect(create.statusCode).toBe(200);
    const id = create.json().instance.id;

    // /connect returns the broker's redirect URL.
    broker.calls.findOrCreate.length = 0;
    broker.calls.createLink.length = 0;
    const initiate = await app.inject({
      method: 'POST',
      url: `/api/connectors/${id}/connect`,
      headers: { cookie },
    });
    expect(initiate.statusCode).toBe(200);
    expect(initiate.json().redirectUrl).toMatch(/composio\/lk_bos-/);
    expect(broker.calls.findOrCreate).toEqual(['gmail']);
    expect(broker.calls.createLink).toHaveLength(1);

    // Before the user has consented, finalize returns pending.
    broker.setActive(null);
    const pending = await app.inject({
      method: 'POST',
      url: `/api/connectors/${id}/finalize-connect`,
      headers: { cookie },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ pending: true });

    // Now the broker reports ACTIVE — finalize persists creds + activates.
    broker.setActive('ca_real_account');
    const done = await app.inject({
      method: 'POST',
      url: `/api/connectors/${id}/finalize-connect`,
      headers: { cookie },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ ok: true, connectedAccountId: 'ca_real_account' });

    // Instance should now be active.
    const list = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: { cookie },
    });
    const emailCap = list
      .json()
      .capabilities.find((c: { capability: string }) => c.capability === 'email');
    const inst = emailCap.instances.find((i: { id: string }) => i.id === id);
    expect(inst.isActive).toBe(true);
  });

  it('/connect rejects non-externalOAuth connectors with 400', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: { cookie },
      payload: {
        capability: 'email',
        providerSlug: 'gmail',
        displayName: 'Direct Gmail',
      },
    });
    const id = create.json().instance.id;
    const r = await app.inject({
      method: 'POST',
      url: `/api/connectors/${id}/connect`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('connector_does_not_use_external_oauth');
  });

  it('/connect returns 503 when the broker is not wired', async () => {
    const secrets = createSecretsStore(env.db, encryptionKey);
    const bare = buildApp({
      db: env.db,
      secrets,
      encryptionKey,
      clientSlug: 'test',
      logger: false,
      serveUi: false,
      inventory: fakeInventory(),
      // No externalOAuthBrokers
    });
    await bare.ready();
    try {
      const login = await bare.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'op@example.com', password: 'correct-horse-battery-staple' },
      });
      const setCookie = login.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const m = (header ?? '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
      const bareCookie = `${SESSION_COOKIE}=${m?.[1]}`;
      // Make a fresh composio-backed instance against the bare app.
      const create = await bare.inject({
        method: 'POST',
        url: '/api/connectors',
        headers: { cookie: bareCookie },
        payload: {
          capability: 'email',
          providerSlug: 'email-gmail-composio',
          displayName: 'Gmail (bare)',
        },
      });
      const id = create.json().instance.id;
      const r = await bare.inject({
        method: 'POST',
        url: `/api/connectors/${id}/connect`,
        headers: { cookie: bareCookie },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe('external_oauth_broker_not_wired');
    } finally {
      await bare.close();
    }
  });

  it('agent bindings round-trip + validate against requiredConnectors + existence', async () => {
    // Create two LLM connector instances (both can be connected — the
    // one-active-per-cap restriction is gone).
    const a = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: { cookie },
      payload: { capability: 'llm', providerSlug: 'anthropic', displayName: 'Anthropic A' },
    });
    const b = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: { cookie },
      payload: { capability: 'llm', providerSlug: 'anthropic', displayName: 'Anthropic B' },
    });
    const idA = a.json().instance.id;
    const idB = b.json().instance.id;

    // Email instance — used to verify capability mismatch is rejected.
    const e = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: { cookie },
      payload: { capability: 'email', providerSlug: 'gmail', displayName: 'Gmail E' },
    });
    const idE = e.json().instance.id;

    // Reject: capability the agent doesn't require.
    const bad1 = await app.inject({
      method: 'PUT',
      url: '/api/agents/leadgen/bindings',
      headers: { cookie },
      payload: { bindings: { 'file-storage': idA } },
    });
    expect(bad1.statusCode).toBe(400);
    expect(bad1.json().error).toBe('capability_not_required_by_agent');

    // Reject: instance for the wrong capability.
    const bad2 = await app.inject({
      method: 'PUT',
      url: '/api/agents/leadgen/bindings',
      headers: { cookie },
      payload: { bindings: { llm: idE } },
    });
    expect(bad2.statusCode).toBe(400);
    expect(bad2.json().error).toBe('instance_capability_mismatch');

    // Reject: nonexistent instance.
    const bad3 = await app.inject({
      method: 'PUT',
      url: '/api/agents/leadgen/bindings',
      headers: { cookie },
      payload: { bindings: { llm: '00000000-0000-0000-0000-000000000000' } },
    });
    expect(bad3.statusCode).toBe(400);
    expect(bad3.json().error).toBe('connector_instance_not_found');

    // Happy path: bind both required caps.
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/agents/leadgen/bindings',
      headers: { cookie },
      payload: { bindings: { llm: idA, email: idE } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().bindings).toEqual({ llm: idA, email: idE });

    // GET surfaces bindings on the agent detail.
    const get = await app.inject({
      method: 'GET',
      url: '/api/agents/leadgen',
      headers: { cookie },
    });
    expect(get.json().connectorBindings).toEqual({ llm: idA, email: idE });

    // Re-binding to instance B overwrites.
    const re = await app.inject({
      method: 'PUT',
      url: '/api/agents/leadgen/bindings',
      headers: { cookie },
      payload: { bindings: { llm: idB, email: idE } },
    });
    expect(re.statusCode).toBe(200);
    expect(re.json().bindings.llm).toBe(idB);

    // Cleanup: delete the instances we created here so later tests aren't
    // affected.
    for (const id of [idA, idB, idE]) {
      await app.inject({ method: 'DELETE', url: `/api/connectors/${id}`, headers: { cookie } });
    }
  });

  it('admin endpoints return 503 when inventory is not wired', async () => {
    const secrets = createSecretsStore(env.db, encryptionKey);
    const bare = buildApp({
      db: env.db,
      secrets,
      encryptionKey,
      clientSlug: 'test',
      logger: false,
      serveUi: false,
      // no inventory, no trigger
    });
    await bare.ready();
    try {
      // Need a session for this app too — but we can reuse the user.
      const login = await bare.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'op@example.com', password: 'correct-horse-battery-staple' },
      });
      const setCookie = login.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const m = (header ?? '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
      const bareCookie = `${SESSION_COOKIE}=${m?.[1]}`;
      const r = await bare.inject({
        method: 'GET',
        url: '/api/agents',
        headers: { cookie: bareCookie },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe('inventory_not_wired');
    } finally {
      await bare.close();
    }
  });
});
