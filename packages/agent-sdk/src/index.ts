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
