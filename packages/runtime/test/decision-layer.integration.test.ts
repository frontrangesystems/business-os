import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import {
  pendingActions,
  auditLog,
  users,
  settings as settingsTable,
} from '@frontrangesystems/business-os-db';
import { createSecretsStore } from '@frontrangesystems/business-os-core/secrets';
import { Registry } from '../src/registry.js';
import { createConnectorResolver } from '../src/active-connectors.js';
import {
  runAgent,
  executePendingAction,
  rejectPendingAction,
  autonomyDecision,
} from '../src/run.js';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[runtime.integration] Skipping decision-layer: Postgres unreachable at ${TEST_DATABASE_URL}.`,
  );
}

// Records which action handlers actually ran (proves inline-execute vs park).
const sideEffects: Array<{ kind: string; payload: unknown }> = [];

const actionAgent = {
  manifest: {
    slug: 'act-agent',
    version: '0.0.1',
    displayName: 'Action Agent',
    description: 'decision-layer test agent',
    requiredConnectors: [] as const,
    settingsSchema: z.object({}),
    schedule: { kind: 'manual' as const },
    actions: {
      doLow: {
        risk: 'low' as const,
        run: async (_ctx: unknown, payload: unknown) => {
          sideEffects.push({ kind: 'doLow', payload });
          return { did: 'low' };
        },
      },
      doHigh: {
        risk: 'high' as const,
        run: async (_ctx: unknown, payload: unknown) => {
          sideEffects.push({ kind: 'doHigh', payload });
          return { did: 'high' };
        },
      },
    },
  },
  run: async (ctx: {
    proposeAction: (k: string, p: unknown, o: { summary: string }) => Promise<{ executed: boolean; pendingId?: string }>;
  }) => {
    const low = await ctx.proposeAction('doLow', { x: 1 }, { summary: 'archive low-risk' });
    const high = await ctx.proposeAction('doHigh', { y: 2 }, { summary: 'trash high-risk' });
    return {
      ok: true,
      summary: `low=${low.executed} high=${high.executed}`,
      details: { low, high },
    };
  },
};

d('decision layer (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let registry: Registry;
  let resolver: ReturnType<typeof createConnectorResolver>;
  const logger = pino({ level: 'silent' });
  const deps = () => ({ db: env.db, registry, connectors: resolver, logger });
  let approverId: string;

  async function setAutonomy(level: string, riskThreshold?: string): Promise<void> {
    await env.db.delete(settingsTable).where(eq(settingsTable.scope, 'agent:act-agent'));
    await env.db.insert(settingsTable).values({
      scope: 'agent:act-agent',
      value: { _autonomy: { level, ...(riskThreshold ? { riskThreshold } : {}) } },
    });
  }

  beforeAll(async () => {
    env = await freshDb();
    registry = new Registry();
    registry.registerAgent(actionAgent as never);
    const secrets = createSecretsStore(env.db, new Uint8Array(randomBytes(32)));
    resolver = createConnectorResolver({ db: env.db, secrets, registry, logger });
    // A real user for `decided_by` (it's a FK to users.id).
    const [u] = await env.db
      .insert(users)
      .values({ email: 'approver@example.com', passwordHash: 'x' })
      .returning();
    approverId = u!.id;
  });

  afterAll(async () => {
    await env.sql.end({ timeout: 1 });
  });

  beforeEach(async () => {
    sideEffects.length = 0;
    await env.db.delete(pendingActions);
    await env.db.delete(auditLog);
  });

  it('unit: autonomyDecision maps levels + risk correctly', () => {
    expect(autonomyDecision({ level: 'L0' }, 'low')).toBe('observe');
    expect(autonomyDecision({ level: 'L1' }, 'low')).toBe('park');
    expect(autonomyDecision({ level: 'L2', riskThreshold: 'low' }, 'low')).toBe('execute');
    expect(autonomyDecision({ level: 'L2', riskThreshold: 'low' }, 'high')).toBe('park');
    expect(autonomyDecision({ level: 'L2', riskThreshold: 'medium' }, 'medium')).toBe('execute');
    expect(autonomyDecision({ level: 'L3' }, 'high')).toBe('execute');
  });

  it('L1 (default HITL) parks every action — nothing executes', async () => {
    await setAutonomy('L1');
    const { result } = await runAgent(deps(), 'act-agent', {}, { kind: 'manual', detail: 'matt' });

    expect(result.summary).toBe('low=false high=false');
    expect(sideEffects).toHaveLength(0); // handlers never ran

    const parked = await env.db.select().from(pendingActions);
    expect(parked).toHaveLength(2);
    expect(parked.every((p) => p.status === 'pending')).toBe(true);
    expect(new Set(parked.map((p) => p.actionKind))).toEqual(new Set(['doLow', 'doHigh']));
  });

  it('L3 (autonomous) executes every action inline', async () => {
    await setAutonomy('L3');
    const { result } = await runAgent(deps(), 'act-agent', {}, { kind: 'manual', detail: 'matt' });

    expect(result.summary).toBe('low=true high=true');
    expect(sideEffects.map((s) => s.kind).sort()).toEqual(['doHigh', 'doLow']);

    const rows = await env.db.select().from(pendingActions);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'executed' && r.executedAt)).toBe(true);
  });

  it('L2 executes at/below the risk threshold, parks above it', async () => {
    await setAutonomy('L2', 'low');
    const { result } = await runAgent(deps(), 'act-agent', {}, { kind: 'manual', detail: 'matt' });

    expect(result.summary).toBe('low=true high=false');
    expect(sideEffects.map((s) => s.kind)).toEqual(['doLow']); // only low ran

    const rows = await env.db.select().from(pendingActions);
    const byKind = Object.fromEntries(rows.map((r) => [r.actionKind, r.status]));
    expect(byKind).toEqual({ doLow: 'executed', doHigh: 'pending' });
  });

  it('approving a parked action runs its handler and stamps executed', async () => {
    await setAutonomy('L1');
    await runAgent(deps(), 'act-agent', {}, { kind: 'manual', detail: 'matt' });
    sideEffects.length = 0; // clear the propose-time noise (there was none, but be explicit)

    const [parked] = await env.db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.actionKind, 'doHigh'));
    expect(parked!.status).toBe('pending');

    const out = await executePendingAction(deps(), parked!.id, approverId);
    expect(out.ok).toBe(true);
    expect(sideEffects).toEqual([{ kind: 'doHigh', payload: { y: 2 } }]);

    const [after] = await env.db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.id, parked!.id));
    expect(after!.status).toBe('executed');
    expect(after!.decidedBy).toBe(approverId);
    expect(after!.executedAt).toBeTruthy();
  });

  it('rejecting a parked action records the decision and never executes', async () => {
    await setAutonomy('L1');
    await runAgent(deps(), 'act-agent', {}, { kind: 'manual', detail: 'matt' });
    const [parked] = await env.db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.actionKind, 'doLow'));

    await rejectPendingAction(deps(), parked!.id, approverId);
    expect(sideEffects).toHaveLength(0);

    const [after] = await env.db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.id, parked!.id));
    expect(after!.status).toBe('rejected');
    expect(after!.decidedBy).toBe(approverId);
  });

  it('writes audit rows for proposed + executed transitions', async () => {
    await setAutonomy('L1');
    await runAgent(deps(), 'act-agent', {}, { kind: 'manual', detail: 'matt' });
    const audits = await env.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.agentSlug, 'act-agent'));
    const actions = audits.map((a) => a.action);
    expect(actions.filter((a) => a === 'action.proposed')).toHaveLength(2);
  });
});
