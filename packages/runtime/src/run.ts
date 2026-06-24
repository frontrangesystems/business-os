import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '@frontrangesystems/business-os-db';
import {
  agentRuns,
  pendingActions,
  settings as settingsTable,
} from '@frontrangesystems/business-os-db';
import type {
  ActionRisk,
  AgentContext,
  AgentResult,
  AutonomyLevel,
  AutonomySettings,
  Logger as AgentLogger,
  ProposeActionResult,
} from '@frontrangesystems/business-os-agent-sdk';
import { DEFAULT_AUTONOMY } from '@frontrangesystems/business-os-agent-sdk';
import type { ConnectorCapabilityMap } from '@frontrangesystems/business-os-connector-sdk';
import type { Logger } from 'pino';
import { audit, type AuditContext } from '@frontrangesystems/business-os-core/audit';
import type { Registry } from './registry.js';
import type { ConnectorResolver } from './active-connectors.js';

export interface RunAgentDeps {
  db: Db;
  registry: Registry;
  connectors: ConnectorResolver;
  logger: Logger;
  /**
   * Optional jobs backend. When provided, agents that call ctx.jobs.enqueue
   * persist work durably. When omitted, enqueue throws — useful for unit
   * tests that don't exercise the queue.
   */
  jobs?: { enqueue(name: string, payload: unknown, opts?: { delayMs?: number; idempotencyKey?: string }): Promise<string> };
  /**
   * Optional error sink. When provided, runAgent calls this whenever an
   * agent throws — used by client shells to forward to Sentry (via
   * captureAgentError in @frontrangesystems/business-os-core/sentry).
   */
  onAgentError?: (err: unknown, ctx: { agentSlug: string; runId: string }) => void;
}

export interface RunTrigger {
  kind: 'cron' | 'manual' | 'event';
  /** cron expression, user-id for manual, or topic for event */
  detail: string;
  /** When kind === 'manual', the user that pressed "Run now" */
  triggeredBy?: string;
}

const SETTINGS_SCOPE = (slug: string): string => `agent:${slug}`;

function adaptLogger(p: Logger): AgentLogger {
  return {
    trace: (o, m) => p.trace(o as object, m),
    debug: (o, m) => p.debug(o as object, m),
    info: (o, m) => p.info(o as object, m),
    warn: (o, m) => p.warn(o as object, m),
    error: (o, m) => p.error(o as object, m),
  };
}

// ----- autonomy (the decision layer) -----------------------------------------

const RISK_ORDER: Record<ActionRisk, number> = { low: 0, medium: 1, high: 2 };

/** Coerce a raw settings `_autonomy` blob into a valid AutonomySettings. */
export function parseAutonomy(raw: unknown): AutonomySettings {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const level = (['L0', 'L1', 'L2', 'L3'] as const).includes(o.level as AutonomyLevel)
      ? (o.level as AutonomyLevel)
      : DEFAULT_AUTONOMY.level;
    const riskThreshold = (['low', 'medium', 'high'] as const).includes(
      o.riskThreshold as ActionRisk,
    )
      ? (o.riskThreshold as ActionRisk)
      : DEFAULT_AUTONOMY.riskThreshold;
    return { level, riskThreshold };
  }
  return DEFAULT_AUTONOMY;
}

/**
 * Given an autonomy level + an action's risk, decide what happens when the
 * agent proposes that action:
 *   - observe (L0): record intent, never execute.
 *   - park (L1, or L2 above threshold): queue for human approval.
 *   - execute (L3, or L2 at/below threshold): run the handler inline.
 */
export function autonomyDecision(
  autonomy: AutonomySettings,
  risk: ActionRisk,
): 'observe' | 'park' | 'execute' {
  switch (autonomy.level) {
    case 'L0':
      return 'observe';
    case 'L1':
      return 'park';
    case 'L2':
      return RISK_ORDER[risk] <= RISK_ORDER[autonomy.riskThreshold ?? 'low']
        ? 'execute'
        : 'park';
    case 'L3':
      return 'execute';
  }
}

// ----- shared context builder -------------------------------------------------

interface BuiltContext {
  ctx: AgentContext;
  /** Parsed agent settings (autonomy stripped out). */
  settings: unknown;
  autonomy: AutonomySettings;
}

/**
 * Build the AgentContext for one agent invocation (a run, or an approved
 * action's execution). Loads + parses settings, reads the framework-managed
 * `_autonomy` block, and wires logger / connectors / audit / jobs / proposeAction.
 * Shared by runAgent and executePendingAction so both get identical ctx.
 */
async function buildContext(
  deps: RunAgentDeps,
  slug: string,
  runId: string,
  trigger: RunTrigger,
): Promise<BuiltContext> {
  const agent = deps.registry.getAgent(slug);

  const rows = await deps.db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.scope, SETTINGS_SCOPE(slug)))
    .limit(1);
  const raw = (rows[0]?.value ?? {}) as Record<string, unknown>;
  // `_autonomy` is framework-managed and not part of the agent's own schema.
  const { _autonomy, ...settingsInput } = raw;
  const autonomy = parseAutonomy(_autonomy);
  const settings = agent.manifest.settingsSchema.parse(settingsInput);

  const childLogger = deps.logger.child({ agent_slug: slug, run_id: runId });

  const auditFn = async (action: string, meta?: Record<string, unknown>): Promise<void> => {
    const ac: AuditContext = {
      db: deps.db,
      requestId: runId,
      userId: trigger.triggeredBy ?? null,
      agentSlug: slug,
    };
    await audit(ac, action, meta);
  };

  const ctx: AgentContext = {
    settings,
    logger: adaptLogger(childLogger),
    connector: (<C extends keyof ConnectorCapabilityMap>(
      capability: C,
      opts?: { providerSlug?: string },
    ) =>
      deps.connectors.resolve(capability, {
        ...opts,
        agentSlug: slug,
      })) as unknown as AgentContext['connector'],
    db: deps.db,
    audit: auditFn,
    jobs: {
      enqueue: deps.jobs
        ? (name, payload, opts) => deps.jobs!.enqueue(name, payload, opts)
        : async () => {
            throw new Error(
              'jobs.enqueue: no jobs backend wired. Pass `jobs` to runAgent() or use createJobsBackend().',
            );
          },
    },
    runId,
    modules: deps.registry.listModules().map((m) => ({
      slug: m.manifest.slug,
      displayName: m.manifest.displayName,
      digestContribution: m.digestContribution as
        | ((ctx: { user: { id: string; email: string }; since: Date; logger: AgentLogger; settings: unknown }) => Promise<{
            sectionTitle: string;
            summary?: string;
            items: Array<{ title: string; subtitle?: string; href: string; isUrgent?: boolean }>;
          } | null>)
        | undefined,
    })),
    // Real implementation attached below (needs a reference to `ctx` itself so
    // inline execution hands the action handler the same context).
    proposeAction: async () => {
      throw new Error('proposeAction not initialized');
    },
  };

  ctx.proposeAction = async (
    kind: string,
    payload: unknown,
    opts: { summary: string },
  ): Promise<ProposeActionResult> => {
    const def = agent.manifest.actions?.[kind];
    if (!def) {
      throw new Error(`proposeAction: agent '${slug}' has no action '${kind}'`);
    }
    const decision = autonomyDecision(autonomy, def.risk);

    if (decision === 'observe') {
      await auditFn('action.observed', { kind, risk: def.risk, summary: opts.summary });
      return { executed: false };
    }

    if (decision === 'execute') {
      try {
        const result = await def.run(ctx, payload);
        await deps.db.insert(pendingActions).values({
          agentSlug: slug,
          runId,
          actionKind: kind,
          payload: payload ?? {},
          summary: opts.summary,
          risk: def.risk,
          status: 'executed',
          executedAt: new Date(),
          result: (result ?? null) as Record<string, unknown> | null,
        });
        await auditFn('action.auto_executed', { kind, risk: def.risk });
        return { executed: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await deps.db.insert(pendingActions).values({
          agentSlug: slug,
          runId,
          actionKind: kind,
          payload: payload ?? {},
          summary: opts.summary,
          risk: def.risk,
          status: 'failed',
          executedAt: new Date(),
          result: { error: message },
        });
        await auditFn('action.failed', { kind, risk: def.risk, error: message });
        throw err;
      }
    }

    // park — queue for human approval.
    const [row] = await deps.db
      .insert(pendingActions)
      .values({
        agentSlug: slug,
        runId,
        actionKind: kind,
        payload: payload ?? {},
        summary: opts.summary,
        risk: def.risk,
        status: 'pending',
      })
      .returning();
    if (!row) throw new Error('proposeAction: failed to record pending action');
    await auditFn('action.proposed', { pendingId: row.id, kind, risk: def.risk });
    return { executed: false, pendingId: row.id };
  };

  return { ctx, settings, autonomy };
}

/**
 * Runs an agent end-to-end:
 *   1. Inserts an agent_runs row (status: in-flight, no end yet).
 *   2. Loads + validates settings against the manifest schema.
 *   3. Builds the AgentContext: logger, db, connector resolver, audit, jobs,
 *      proposeAction (the decision layer).
 *   4. Calls agent.run(ctx, input).
 *   5. Stamps the agent_runs row with ok/summary/details/ended_at.
 *
 * Throws are caught: a thrown agent error is recorded as ok=false on the row
 * (and re-thrown for the scheduler's own bookkeeping).
 */
export async function runAgent(
  deps: RunAgentDeps,
  slug: string,
  input: unknown,
  trigger: RunTrigger,
): Promise<{ runId: string; result: AgentResult }> {
  const agent = deps.registry.getAgent(slug);
  const runId = randomUUID();

  await deps.db.insert(agentRuns).values({
    id: runId,
    agentSlug: slug,
    trigger: `${trigger.kind}:${trigger.detail}`,
    triggeredBy: trigger.triggeredBy,
  });

  const { ctx } = await buildContext(deps, slug, runId, trigger);

  // Validate input against the agent's inputSchema before calling run().
  const validatedInput = agent.manifest.inputSchema
    ? agent.manifest.inputSchema.parse(input)
    : input;

  const childLogger = deps.logger.child({ agent_slug: slug, run_id: runId });

  try {
    const result = await agent.run(ctx, validatedInput);
    await deps.db
      .update(agentRuns)
      .set({
        endedAt: new Date(),
        ok: result.ok,
        summary: result.summary,
        details: result.details ?? null,
      })
      .where(eq(agentRuns.id, runId));
    childLogger.info({ ok: result.ok, summary: result.summary }, 'agent.run finished');
    return { runId, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.db
      .update(agentRuns)
      .set({
        endedAt: new Date(),
        ok: false,
        summary: `error: ${message}`,
        details: { error: message },
      })
      .where(eq(agentRuns.id, runId));
    childLogger.error({ err }, 'agent.run threw');
    if (deps.onAgentError) {
      try {
        deps.onAgentError(err, { agentSlug: slug, runId });
      } catch {
        // never let an error sink mask the original throw
      }
    }
    throw err;
  }
}

export interface ExecuteActionResult {
  ok: boolean;
  result?: unknown;
}

/**
 * Execute a parked action after a human approves it. Loads the pending_actions
 * row, rebuilds the proposing agent's context, runs the declared handler, and
 * stamps the row 'executed'/'failed' with the result. Used by the Approvals
 * API's approve route. `decidedBy` is the approving user's id.
 */
export async function executePendingAction(
  deps: RunAgentDeps,
  pendingId: string,
  decidedBy: string | null,
): Promise<ExecuteActionResult> {
  const [row] = await deps.db
    .select()
    .from(pendingActions)
    .where(eq(pendingActions.id, pendingId))
    .limit(1);
  if (!row) throw new Error(`pending action ${pendingId} not found`);
  if (row.status !== 'pending' && row.status !== 'approved') {
    throw new Error(`pending action ${pendingId} is '${row.status}', not executable`);
  }

  const agent = deps.registry.getAgent(row.agentSlug);
  const def = agent.manifest.actions?.[row.actionKind];
  if (!def) {
    throw new Error(`agent '${row.agentSlug}' has no action '${row.actionKind}'`);
  }

  const runId = randomUUID();
  const { ctx } = await buildContext(deps, row.agentSlug, runId, {
    kind: 'manual',
    detail: decidedBy ?? 'approval',
    triggeredBy: decidedBy ?? undefined,
  });

  try {
    const result = await def.run(ctx, row.payload);
    await deps.db
      .update(pendingActions)
      .set({
        status: 'executed',
        decidedBy: decidedBy ?? null,
        decidedAt: new Date(),
        executedAt: new Date(),
        result: (result ?? null) as Record<string, unknown> | null,
      })
      .where(eq(pendingActions.id, pendingId));
    await ctx.audit('action.executed', { pendingId, kind: row.actionKind });
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.db
      .update(pendingActions)
      .set({
        status: 'failed',
        decidedBy: decidedBy ?? null,
        decidedAt: new Date(),
        executedAt: new Date(),
        result: { error: message },
      })
      .where(eq(pendingActions.id, pendingId));
    await ctx.audit('action.failed', { pendingId, kind: row.actionKind, error: message });
    throw err;
  }
}

/**
 * Reject a parked action — no execution, just records the human's decision.
 */
export async function rejectPendingAction(
  deps: RunAgentDeps,
  pendingId: string,
  decidedBy: string | null,
): Promise<void> {
  const [row] = await deps.db
    .update(pendingActions)
    .set({ status: 'rejected', decidedBy: decidedBy ?? null, decidedAt: new Date() })
    .where(eq(pendingActions.id, pendingId))
    .returning();
  if (!row) throw new Error(`pending action ${pendingId} not found`);
}
