import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { settings as settingsTable, type Db } from '@frontrangesystems/business-os-db';
import { AGENT_REFRESH_CHANNEL } from '@frontrangesystems/business-os-core';
import {
  friendlyToCron,
  type FriendlySchedule,
} from '@frontrangesystems/business-os-agent-sdk';
import type { Registry } from './registry.js';
import type { ConnectorResolver } from './active-connectors.js';
import { runAgent, type RunTrigger } from './run.js';

/**
 * Structural view of postgres-js's LISTEN handle. Typed structurally rather
 * than importing `Sql` from `postgres` so runtime needs no new dependency
 * (`postgres` is only a transitive dep via db). The real postgres-js client
 * satisfies this shape; it auto-reconnects and re-issues the LISTEN on
 * reconnect, so the listener survives transient connection loss.
 */
export interface AgentRefreshListener {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
  ): Promise<{ unlisten(): Promise<void> }>;
}

/**
 * The operator-set override is now stored as a `FriendlySchedule` (interval /
 * daily / weekly / manual / event, plus a raw-cron escape hatch). Older
 * installs may still have a raw `{ kind: 'cron', expr }` row persisted — that's
 * a valid FriendlySchedule kind, so it parses + schedules unchanged
 * (backward-compatible).
 */
type AgentScheduleOverride = FriendlySchedule;

/**
 * Parse a stored override value into a `FriendlySchedule`, tolerating the
 * legacy shapes (`{kind:'manual'}`, `{kind:'cron',expr}`, `{kind:'event',topic}`)
 * which are a strict subset of the friendly union. Returns `null` for anything
 * unrecognised so a junk row never crashes the scheduler.
 */
function parseOverride(value: unknown): AgentScheduleOverride | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as {
    kind?: string;
    expr?: string;
    topic?: string;
    every?: string;
    n?: number;
    at?: string;
    day?: number;
  };
  switch (o.kind) {
    case 'manual':
      return { kind: 'manual' };
    case 'cron':
      return typeof o.expr === 'string' ? { kind: 'cron', expr: o.expr } : null;
    case 'event':
      return typeof o.topic === 'string' ? { kind: 'event', topic: o.topic } : null;
    case 'interval':
      return (o.every === 'minute' || o.every === 'hour') && typeof o.n === 'number'
        ? { kind: 'interval', every: o.every, n: o.n }
        : null;
    case 'daily':
      return typeof o.at === 'string' ? { kind: 'daily', at: o.at } : null;
    case 'weekly':
      return typeof o.day === 'number' && typeof o.at === 'string'
        ? { kind: 'weekly', day: o.day, at: o.at }
        : null;
    default:
      return null;
  }
}

/**
 * Read both the operator-set override (`agent-schedule:<slug>`) and the
 * enable bit (`agent-enabled:<slug>`) from the DB. Disabled agents return
 * `null` — caller skips scheduling them entirely.
 */
async function readScheduleState(
  db: Db,
  slug: string,
): Promise<{ enabled: boolean; override: AgentScheduleOverride | null }> {
  const rows = await db
    .select({ scope: settingsTable.scope, value: settingsTable.value })
    .from(settingsTable);
  const byScope = new Map<string, unknown>();
  for (const r of rows) byScope.set(r.scope, r.value);
  const enabledRow = byScope.get(`agent-enabled:${slug}`) as { enabled?: boolean } | undefined;
  const enabled = enabledRow?.enabled === true;
  const override = parseOverride(byScope.get(`agent-schedule:${slug}`));
  return { enabled, override };
}

/**
 * In-process scheduler.
 *
 * Boots every cron-scheduled agent into a Cron job. Manual + event-triggered
 * agents stay idle until `triggerManual()` / `fireEvent()` is called.
 *
 * Distinguishing it from pg-boss:
 *  - This scheduler is *trigger* infrastructure: when should the runtime
 *    call runAgent?
 *  - pg-boss (TBD) is *queue* infrastructure: how do we persist + retry the
 *    work an agent enqueues via ctx.jobs.enqueue()?
 *
 * Multi-instance deploys must pick exactly one process to host the scheduler
 * — there's no leader election here yet. Single-process is fine for now since
 * each client install runs in one place.
 */

export interface SchedulerDeps {
  db: Db;
  registry: Registry;
  connectors: ConnectorResolver;
  logger: Logger;
  /**
   * Raw postgres-js client used only for LISTEN/NOTIFY. When provided, the
   * scheduler LISTENs on AGENT_REFRESH_CHANNEL and live-refreshes an agent
   * whenever the api process NOTIFYs (enable/disable/schedule change). When
   * omitted, the scheduler behaves exactly as before — no listener, changes
   * take effect on next restart.
   */
  sql?: AgentRefreshListener;
  /**
   * Optional jobs backend. When wired, agents triggered by the scheduler
   * (cron/manual/event) can use ctx.jobs.enqueue. When omitted, enqueue
   * throws — same fallback as runAgent() without a backend.
   */
  jobs?: { enqueue(name: string, payload: unknown, opts?: { delayMs?: number; idempotencyKey?: string }): Promise<string> };
  /** Forwarded to runAgent.onAgentError. */
  onAgentError?: (err: unknown, ctx: { agentSlug: string; runId: string }) => void;
}

export class Scheduler {
  private crons = new Map<string, Cron>();
  /** topic -> list of agent slugs subscribed via manifest.schedule.kind === 'event' */
  private eventSubs = new Map<string, string[]>();
  private started = false;
  /** LISTEN handle for cross-process refresh; present only when deps.sql is set. */
  private refreshListener?: { unlisten(): Promise<void> };

  constructor(private deps: SchedulerDeps) {}

  /**
   * Walk the registry. For each agent: if it's DB-enabled, start a cron job
   * (or wire an event subscription) per the effective schedule = override
   * ?? manifest. Disabled agents are skipped entirely.
   */
  async start(): Promise<void> {
    if (this.started) throw new Error('Scheduler already started');
    for (const agent of this.deps.registry.listAgents()) {
      await this.scheduleAgent(agent.manifest.slug);
    }
    if (this.deps.sql) {
      this.refreshListener = await this.deps.sql.listen(AGENT_REFRESH_CHANNEL, (payload) => {
        this.refreshAgent(payload).catch((err) =>
          this.deps.logger.error({ err, slug: payload }, 'agent-refresh failed'),
        );
      });
      this.deps.logger.info(
        { channel: AGENT_REFRESH_CHANNEL },
        'scheduler listening for agent refresh',
      );
    }
    this.started = true;
    this.deps.logger.info(
      { cronCount: this.crons.size, eventTopics: this.eventSubs.size },
      'scheduler.started',
    );
  }

  /**
   * Re-read enable + override for a single agent and adjust crons/event
   * subscriptions. Called by the API when the operator changes the schedule
   * or enables/disables an agent, so changes take effect without a restart.
   */
  async refreshAgent(slug: string): Promise<void> {
    this.unscheduleAgent(slug);
    await this.scheduleAgent(slug);
  }

  private unscheduleAgent(slug: string): void {
    const existing = this.crons.get(slug);
    if (existing) {
      existing.stop();
      this.crons.delete(slug);
    }
    for (const [topic, subs] of this.eventSubs) {
      const next = subs.filter((s) => s !== slug);
      if (next.length === 0) this.eventSubs.delete(topic);
      else this.eventSubs.set(topic, next);
    }
  }

  private async scheduleAgent(slug: string): Promise<void> {
    let agent;
    try {
      agent = this.deps.registry.getAgent(slug);
    } catch {
      return; // not registered — nothing to schedule
    }
    const state = await readScheduleState(this.deps.db, slug);
    if (!state.enabled) return; // disabled agents stay idle
    // Effective schedule = operator override (a FriendlySchedule) ?? the
    // manifest's declared schedule (the SDK AgentSchedule, a strict subset of
    // the friendly union). Either way we resolve it to a single cron expression
    // for time-based kinds; manual/event are handled separately.
    const s: FriendlySchedule = state.override ?? agent.manifest.schedule;
    if (s.kind === 'manual') {
      // nothing to do; operator drives via /run.
      return;
    }
    if (s.kind === 'event') {
      const list = this.eventSubs.get(s.topic) ?? [];
      list.push(slug);
      this.eventSubs.set(s.topic, list);
      return;
    }
    // interval / daily / weekly / cron all resolve to a cron expression.
    let expr: string;
    try {
      expr = friendlyToCron(s);
    } catch (err) {
      this.deps.logger.error({ err, slug, schedule: s }, 'scheduler.invalid_schedule');
      return;
    }
    const cron = new Cron(expr, { timezone: 'UTC', protect: true }, async () => {
      await this.fireRun(slug, undefined, { kind: 'cron', detail: expr });
    });
    this.crons.set(slug, cron);
  }

  async stop(): Promise<void> {
    if (this.refreshListener) {
      await this.refreshListener.unlisten().catch(() => {});
      this.refreshListener = undefined;
    }
    for (const c of this.crons.values()) c.stop();
    this.crons.clear();
    this.eventSubs.clear();
    this.started = false;
  }

  /**
   * Trigger an agent manually. Works for any schedule kind — the operator can
   * always click "Run now" regardless of how the agent is normally fired.
   */
  async triggerManual(slug: string, input: unknown, triggeredBy: string): Promise<void> {
    await this.fireRun(slug, input, { kind: 'manual', detail: triggeredBy, triggeredBy });
  }

  /**
   * Fire an event topic; every agent subscribed to it runs (sequentially).
   */
  async fireEvent(topic: string, payload: unknown): Promise<void> {
    const subs = this.eventSubs.get(topic) ?? [];
    for (const slug of subs) {
      await this.fireRun(slug, payload, { kind: 'event', detail: topic });
    }
  }

  /** Visible only for tests. */
  _hasCron(slug: string): boolean {
    return this.crons.has(slug);
  }
  _subscribers(topic: string): string[] {
    return [...(this.eventSubs.get(topic) ?? [])];
  }

  private async fireRun(slug: string, input: unknown, trigger: RunTrigger): Promise<void> {
    try {
      await runAgent(
        {
          db: this.deps.db,
          registry: this.deps.registry,
          connectors: this.deps.connectors,
          logger: this.deps.logger,
          jobs: this.deps.jobs,
          onAgentError: this.deps.onAgentError,
        },
        slug,
        input,
        trigger,
      );
    } catch (err) {
      // Errors are already recorded in agent_runs by runAgent. Don't propagate
      // out of the cron callback — a thrown error would kill the cron timer.
      this.deps.logger.error({ err, slug }, 'scheduler.run_failed');
    }
  }
}
