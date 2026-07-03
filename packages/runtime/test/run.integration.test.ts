import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pino } from 'pino';
import { connectorInstances, agentRuns, auditLog, settings as settingsTable } from '@frontrangesystems/business-os-db';
import { eq } from 'drizzle-orm';
import { createSecretsStore } from '@frontrangesystems/business-os-core/secrets';
import { Registry } from '../src/registry.js';
import {
  createConnectorResolver,
  MissingAgentBindingError,
} from '../src/active-connectors.js';
import { runAgent } from '../src/run.js';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[runtime.integration] Skipping: Postgres unreachable at ${TEST_DATABASE_URL}. ` +
      `Start it with \`docker compose up -d postgres\` to run these tests.`,
  );
}

const SETTINGS_SCHEMA = z.object({
  greeting: z.string().default('hello'),
});
const fakeAgent = {
  manifest: {
    slug: 'fake-leadgen',
    version: '0.0.1',
    displayName: 'Fake Leadgen',
    description: 'integration test agent',
    requiredConnectors: ['email'] as const,
    settingsSchema: SETTINGS_SCHEMA,
    schedule: { kind: 'manual' as const },
  },
  run: async (ctx: { connector: (c: 'email', opts?: { providerSlug?: string }) => Promise<{ send: (m: object) => Promise<{ messageId: string }> }>; settings: z.infer<typeof SETTINGS_SCHEMA>; audit: (a: string, m?: object) => Promise<void> }, input: { to: string }) => {
    const email = await ctx.connector('email');
    const r = await email.send({ to: input.to, subject: ctx.settings.greeting, text: 'hi' });
    await ctx.audit('fake.sent', { to: input.to, messageId: r.messageId });
    return { ok: true, summary: `sent to ${input.to}`, details: { messageId: r.messageId } };
  },
};

const fakeEmailProvider = {
  manifest: {
    slug: 'fake-email',
    capability: 'email' as const,
    version: '0.0.1',
    displayName: 'Fake Email',
    authKind: 'none' as const,
    settingsSchema: z.object({}),
  },
  capability: 'email' as const,
  factory: () => ({
    send: async (msg: { to: string }) => ({ messageId: `fake-${msg.to}` }),
  }),
};

d('runAgent (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let registry: Registry;
  let resolver: ReturnType<typeof createConnectorResolver>;
  let emailInstanceId: string;
  const encryptionKey = new Uint8Array(randomBytes(32));
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    env = await freshDb();
    registry = new Registry();
    registry.registerAgent(fakeAgent as never);
    registry.registerConnectorProvider(fakeEmailProvider);
    const secrets = createSecretsStore(env.db, encryptionKey);
    resolver = createConnectorResolver({
      db: env.db,
      secrets,
      registry,
      logger,
    });

    // Mark the email provider active.
    const inserted = await env.db
      .insert(connectorInstances)
      .values({
        capability: 'email',
        providerSlug: 'fake-email',
        displayName: 'Fake Email',
        isActive: true,
      })
      .returning();
    emailInstanceId = inserted[0]!.id;

    // Seed agent settings + binding (runner now requires bindings per agent).
    await env.db.insert(settingsTable).values([
      { scope: 'agent:fake-leadgen', value: { greeting: 'Welcome!' } },
      { scope: 'agent-bindings:fake-leadgen', value: { email: emailInstanceId } },
    ]);
  });

  afterAll(async () => {
    await env.sql.end({ timeout: 1 });
  });

  it('runs the agent end-to-end and records an agent_runs row', async () => {
    const { runId, result } = await runAgent(
      { db: env.db, registry, connectors: resolver, logger },
      'fake-leadgen',
      { to: 'sam@example.com' },
      { kind: 'manual', detail: 'matt' },
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/sent to sam@example.com/);

    const rows = await env.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    const row = rows[0]!;
    expect(row.agentSlug).toBe('fake-leadgen');
    expect(row.ok).toBe(true);
    expect(row.endedAt).toBeTruthy();
    expect(row.trigger).toBe('manual:matt');

    const audits = await env.db.select().from(auditLog).where(eq(auditLog.agentSlug, 'fake-leadgen'));
    expect(audits.length).toBe(1);
    expect(audits[0]!.action).toBe('fake.sent');
  });

  it('records failure when the agent throws', async () => {
    registry.registerAgent({
      manifest: {
        slug: 'boom',
        version: '0.0.1',
        displayName: 'Boom',
        description: 'always throws',
        requiredConnectors: [] as const,
        settingsSchema: z.object({}),
        schedule: { kind: 'manual' as const },
      },
      run: async () => {
        throw new Error('kaboom');
      },
    });

    await expect(
      runAgent(
        { db: env.db, registry, connectors: resolver, logger },
        'boom',
        {},
        { kind: 'manual', detail: 'matt' },
      ),
    ).rejects.toThrow(/kaboom/);

    const rows = await env.db.select().from(agentRuns).where(eq(agentRuns.agentSlug, 'boom'));
    expect(rows.length).toBe(1);
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.summary).toMatch(/error: kaboom/);
  });

  it('finalizes the run row ok=false when input fails the inputSchema (setup error)', async () => {
    registry.registerAgent({
      manifest: {
        slug: 'strict-input',
        version: '0.0.1',
        displayName: 'Strict Input',
        description: 'requires a non-empty name in input',
        requiredConnectors: [] as const,
        settingsSchema: z.object({}),
        inputSchema: z.object({ name: z.string().min(1) }),
        schedule: { kind: 'manual' as const },
      },
      run: async () => ({ ok: true, summary: 'never reached' }),
    });

    await expect(
      runAgent(
        { db: env.db, registry, connectors: resolver, logger },
        'strict-input',
        { name: '' },
        { kind: 'manual', detail: 'matt' },
      ),
    ).rejects.toThrow();

    // The row must NOT be left dangling as "running" — setup errors stamp it.
    const rows = await env.db.select().from(agentRuns).where(eq(agentRuns.agentSlug, 'strict-input'));
    expect(rows.length).toBe(1);
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.endedAt).toBeTruthy();
  });

  it('throws MissingAgentBindingError when the agent has no binding for a required capability', async () => {
    // Remove the binding row entirely — the agent should refuse to run.
    await env.db
      .delete(settingsTable)
      .where(eq(settingsTable.scope, 'agent-bindings:fake-leadgen'));

    await expect(
      runAgent(
        { db: env.db, registry, connectors: resolver, logger },
        'fake-leadgen',
        { to: 'x@y.z' },
        { kind: 'manual', detail: 'matt' },
      ),
    ).rejects.toBeInstanceOf(MissingAgentBindingError);
  });
});
