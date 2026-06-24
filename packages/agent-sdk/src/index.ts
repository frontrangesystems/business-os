import type { z } from 'zod';
import type { ConnectorCapabilityMap } from '@frontrangesystems/business-os-connector-sdk';

/**
 * Schedule declares when the runtime invokes the agent.
 *  - cron: standard 5-field cron expression (UTC)
 *  - manual: only runs when an operator clicks "Run now" or another agent enqueues it
 *  - event: runs when a named topic fires inside the runtime's event bus
 */
export type AgentSchedule =
  | { kind: 'cron'; expr: string }
  | { kind: 'manual' }
  | { kind: 'event'; topic: string };

export interface AgentManifest<TSettings extends z.ZodTypeAny = z.ZodTypeAny> {
  /** kebab-case unique identifier within the client install */
  slug: string;
  /** semver of the agent package */
  version: string;
  /** Human-readable name shown in the operator UI */
  displayName: string;
  /** One-line description */
  description: string;
  /** Capabilities the agent needs the framework to wire up before `run` */
  requiredConnectors: ReadonlyArray<keyof ConnectorCapabilityMap>;
  /** Zod schema for per-instance settings. Framework auto-renders a form. */
  settingsSchema: TSettings;
  /**
   * Optional Zod schema for the per-run input. When present:
   *   - runAgent validates the input against this schema before calling run().
   *   - The UI's "Manual run" panel renders an auto-generated form instead
   *     of a JSON textarea — same UX as settings.
   * Omit when the agent takes no input or takes an opaque shape.
   */
  inputSchema?: z.ZodTypeAny;
  /** When the runtime should invoke the agent */
  schedule: AgentSchedule;
  /**
   * Named, side-effecting operations this agent can perform — the decision
   * layer (docs/specs/2026-06-24-decision-layer.md). Each is a pure executor:
   * given a payload, do the thing. The agent calls `ctx.proposeAction(kind, …)`
   * during `run`; the framework decides — based on the agent's autonomy level
   * and the action's `risk` — whether to execute it inline or park it in the
   * approval inbox for a human. Omit for agents that never take actions.
   */
  actions?: Record<string, ActionDefinition<z.infer<TSettings>>>;
  /**
   * Which trigger kinds the operator is allowed to switch the agent to.
   * Defaults to `[<schedule.kind>, 'manual']` — i.e. the manifest's
   * declared trigger plus always-allowed manual. Set explicitly to widen
   * (e.g. `['cron', 'manual', 'event']` for an agent that can poll OR
   * subscribe to a webhook).
   *
   * The UI's Schedule subsection only shows radio options that appear here.
   * The runtime checks this list when applying an override.
   */
  supportedTriggers?: ReadonlyArray<'cron' | 'manual' | 'event'>;
}

/** How much an agent is trusted to act on its own — the decision-layer dial. */
export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3';

/** Risk class of an action; drives the L2 auto-approve threshold. */
export type ActionRisk = 'low' | 'medium' | 'high';

/**
 * The framework-managed autonomy setting for an agent. Stored alongside the
 * agent's own settings under the `_autonomy` key; agents never define it (the
 * framework injects the control). See AutonomyLevel for the ladder.
 *   L0 Observe · L1 Draft+approve · L2 Act+notify (≤ riskThreshold) · L3 Autonomous
 */
export interface AutonomySettings {
  level: AutonomyLevel;
  /** At L2, actions with risk ≤ this execute automatically; above it, park. */
  riskThreshold?: ActionRisk;
}

/** Default for any agent with no autonomy configured: supervised (HITL). */
export const DEFAULT_AUTONOMY: AutonomySettings = { level: 'L1', riskThreshold: 'low' };

/**
 * A named, side-effecting operation an agent can perform. `run` is a pure
 * executor — the framework decides WHEN it runs (inline vs after approval).
 * `payload` arrives as `unknown` (it round-trips through the DB as JSON); the
 * handler narrows it.
 */
export interface ActionDefinition<TSettings = unknown> {
  /** Risk class — compared against the agent's L2 threshold. */
  risk: ActionRisk;
  /** One-line description, shown in the approval inbox. */
  description?: string;
  run: (ctx: AgentContext<TSettings>, payload: unknown) => Promise<unknown>;
}

/** Outcome of `ctx.proposeAction`. */
export interface ProposeActionResult {
  /** True if the action ran inline (autonomous); false if parked/observed. */
  executed: boolean;
  /** Set when the action was parked for approval — the pending_actions row id. */
  pendingId?: string;
}

/**
 * AgentContext is what the framework hands the agent at run time.
 * Agents NEVER reach into the framework directly — only through ctx.
 */
export interface AgentContext<TSettings = unknown> {
  /** Decrypted, parsed settings (validated against the manifest's schema) */
  settings: TSettings;
  /** Pino child logger pre-tagged with agent_slug + run_id */
  logger: Logger;
  /**
   * Resolve a connector for a capability.
   *
   * Default behavior — `ctx.connector('llm')` — returns the operator-chosen
   * *active* provider for that capability. Pass `{ providerSlug }` to pin a
   * specific provider, e.g. `ctx.connector('llm', { providerSlug: 'openai' })`.
   *
   * Per-agent provider + model selection is supported: agents that want to
   * vary by configuration read the slug + model from their own settings
   * schema and forward them — see the AgentSdk README for the convention.
   */
  connector<C extends keyof ConnectorCapabilityMap>(
    capability: C,
    opts?: { providerSlug?: string },
  ): Promise<ConnectorCapabilityMap[C]> | ConnectorCapabilityMap[C];
  /** Drizzle client scoped to the client's database */
  db: unknown; // typed once @frontrangesystems/business-os-db is in place
  /** Write an audit-log row */
  audit(action: string, meta?: Record<string, unknown>): Promise<void>;
  /**
   * Propose one of the agent's declared `manifest.actions`. Based on the
   * agent's autonomy level + the action's risk, the framework either runs the
   * action's handler inline (L3, or L2 at/below the risk threshold) or parks a
   * pending_actions row for human approval (L1, or L2 above threshold). At L0
   * it only records the intent and never executes. The decision layer — see
   * docs/specs/2026-06-24-decision-layer.md.
   */
  proposeAction(
    kind: string,
    payload: unknown,
    opts: { summary: string },
  ): Promise<ProposeActionResult>;
  /** Enqueue a follow-up job (handled by the same agent or another) */
  jobs: {
    enqueue(name: string, payload: unknown, opts?: EnqueueOpts): Promise<string>;
  };
  /** Identifier of this run, useful for log correlation */
  runId: string;
  /**
   * Read-only view of the modules registered in this install. Used by
   * framework agents that coordinate across modules — primarily the
   * digest agent calling each module's `digestContribution`. Most agents
   * never touch this.
   */
  modules: ReadonlyArray<AgentVisibleModule>;
}

/**
 * The slice of a module's package an agent is allowed to see. We surface
 * digestContribution explicitly because that's the only cross-module hook
 * an agent needs; routes + uiPages are framework-internal.
 */
export interface AgentVisibleModule {
  slug: string;
  displayName: string;
  digestContribution?: (
    ctx: AgentVisibleDigestContext,
  ) => Promise<AgentVisibleDigestContribution | null>;
}

export interface AgentVisibleDigestContext {
  user: { id: string; email: string };
  since: Date;
  logger: Logger;
  settings: unknown;
}

export interface AgentVisibleDigestContribution {
  sectionTitle: string;
  summary?: string;
  items: Array<{
    title: string;
    subtitle?: string;
    href: string;
    isUrgent?: boolean;
  }>;
}

export interface EnqueueOpts {
  /** Delay in ms before the job becomes eligible */
  delayMs?: number;
  /** Idempotency key — duplicate enqueue with same key is a no-op */
  idempotencyKey?: string;
}

export interface Logger {
  trace(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

/** The function shape every agent package exports as `run`. */
export type AgentRun<TSettings = unknown, TInput = unknown> = (
  ctx: AgentContext<TSettings>,
  input: TInput,
) => Promise<AgentResult>;

/**
 * Helper: defines an agent in a way that infers `TSettings` from the manifest's
 * settingsSchema. Agent packages should use this rather than constructing the
 * types by hand.
 */
export * from './llm-picker.js';
export * from './schedule.js';

export function defineAgent<TSettings extends z.ZodTypeAny>(args: {
  manifest: AgentManifest<TSettings>;
  run: AgentRun<z.infer<TSettings>>;
}): { manifest: AgentManifest<TSettings>; run: AgentRun<z.infer<TSettings>> } {
  return args;
}
