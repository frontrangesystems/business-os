import { Composio, ComposioError } from '@composio/core';
import type { ExternalOAuthBroker } from '@frontrangesystems/business-os-connector-sdk';

/**
 * Substrate for Composio-backed connectors.
 *
 * NOT a `defineConnector` package. This module is consumed by per-capability,
 * per-provider connectors (e.g. @frontrangesystems/business-os-connector-email-gmail-composio)
 * which translate our capability interfaces into Composio tool calls.
 *
 * Design points:
 *  - One ComposioSubstrate instance per (apiKey, toolkit-version-map). Cheap
 *    to construct; cache at the framework level if needed.
 *  - Toolkit versions MUST be pinned. Composio rejects 'latest' on manual
 *    tool execution. Bumping a toolkit version is a deliberate code change
 *    so that breaking changes from upstream APIs surface in our test suite
 *    before they hit production.
 *  - Errors thrown by the underlying SDK are wrapped in ComposioSubstrateError
 *    with a stable `kind` discriminator so connectors can react to specific
 *    failure modes (auth expired, connection not found, rate limited) without
 *    importing all of @composio/core's error taxonomy.
 */

// -----------------------------------------------------------------------------
// Pinned toolkit versions
// -----------------------------------------------------------------------------

/**
 * Default toolkit versions used across Business OS connectors. Add to this
 * registry as new providers are introduced. Per-instance overrides allowed
 * via ComposioSubstrateOptions.toolkitVersions.
 *
 * Bumping a version here is a breaking change for any connector that depends
 * on the affected toolkit — schedule alongside the connector update.
 */
export const DEFAULT_TOOLKIT_VERSIONS: Record<string, string> = {
  gmail: '20260515_00',
  outlook: '20260624_00',
};

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

export interface ComposioSubstrateOptions {
  apiKey: string;
  /** Per-toolkit version overrides. Merged with DEFAULT_TOOLKIT_VERSIONS. */
  toolkitVersions?: Record<string, string>;
}

export interface ExecuteToolParams {
  toolSlug: string;
  userId: string;
  /** Tool-specific arguments (shape per Composio's GMAIL_*, JIRA_*, etc.). */
  arguments: Record<string, unknown>;
}

export interface ExecuteToolResult<TData = unknown> {
  successful: boolean;
  data: TData;
  error?: string;
}

export interface CreateConnectionLinkParams {
  userId: string;
  authConfigId: string;
  /** Where Composio sends the browser after the user finishes consenting. */
  callbackUrl: string;
}

export interface CreateConnectionLinkResult {
  connectionRequestId: string;
  redirectUrl: string;
}

export type ManagedAuthConfig = {
  id: string;
  toolkit: string;
};

/**
 * Discriminated wrapper around any error originating from @composio/core.
 *
 * `kind` is the stable signal connectors react to. The original error is
 * preserved on `.cause` for logging.
 */
export class ComposioSubstrateError extends Error {
  constructor(
    public readonly kind:
      | 'auth-config-not-found'
      | 'connection-not-found'
      | 'connection-expired'
      | 'connection-timeout'
      | 'tool-not-found'
      | 'tool-execution-failed'
      | 'rate-limited'
      | 'unknown',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ComposioSubstrateError';
  }
}

// -----------------------------------------------------------------------------
// Substrate
// -----------------------------------------------------------------------------

export class ComposioSubstrate implements ExternalOAuthBroker {
  private readonly client: Composio;

  constructor(opts: ComposioSubstrateOptions) {
    if (!opts.apiKey) {
      throw new ComposioSubstrateError('unknown', 'composio: apiKey is required');
    }
    this.client = new Composio({
      apiKey: opts.apiKey,
      toolkitVersions: { ...DEFAULT_TOOLKIT_VERSIONS, ...opts.toolkitVersions },
    });
  }

  /**
   * Find an existing managed-auth config for `toolkit`, or create one.
   *
   * The framework should call this once per (install, toolkit) at the time the
   * operator first enables the connector — NOT on every tool execution. The
   * returned id should be persisted as part of the connector instance settings.
   */
  async findOrCreateManagedAuthConfig(toolkit: string, name?: string): Promise<ManagedAuthConfig> {
    try {
      const list = await this.client.authConfigs.list({ toolkit });
      const hit = list.items?.[0];
      if (hit) return { id: hit.id, toolkit };

      const created = await this.client.authConfigs.create(toolkit, {
        type: 'use_composio_managed_auth',
        name: name ?? `business-os-${toolkit}`,
      });
      return { id: created.id, toolkit };
    } catch (e) {
      throw wrapError(e, `find-or-create-auth-config(${toolkit})`);
    }
  }

  /**
   * Start an OAuth flow for `userId`. Returns the URL the browser must visit.
   *
   * Framework usage: call from the "Connect <Provider>" route handler, persist
   * the connectionRequestId, redirect the browser to redirectUrl. On callback,
   * the framework looks up the resulting connectedAccountId via
   * `getActiveConnection` and persists it as the credential.
   */
  async createConnectionLink(p: CreateConnectionLinkParams): Promise<CreateConnectionLinkResult> {
    try {
      const conn = await this.client.connectedAccounts.link(p.userId, p.authConfigId, {
        callbackUrl: p.callbackUrl,
      });
      if (!conn.redirectUrl) {
        throw new ComposioSubstrateError(
          'unknown',
          'composio.create-connection-link: SDK returned no redirectUrl',
        );
      }
      return {
        connectionRequestId: conn.id,
        redirectUrl: conn.redirectUrl,
      };
    } catch (e) {
      throw wrapError(e, 'create-connection-link');
    }
  }

  /**
   * Look up the active connectedAccountId for a (userId, toolkit) pair. Used
   * by the OAuth callback handler to record the persistent credential after
   * the user finishes consenting.
   */
  async getActiveConnection(userId: string, toolkit: string): Promise<string | null> {
    try {
      const list = await this.client.connectedAccounts.list({
        userIds: [userId],
        toolkitSlugs: [toolkit],
        statuses: ['ACTIVE'],
      });
      const hit = list.items?.[0];
      return hit?.id ?? null;
    } catch (e) {
      throw wrapError(e, `get-active-connection(${userId}/${toolkit})`);
    }
  }

  /**
   * Execute a Composio tool against a previously-connected user. Connectors
   * call this from inside their capability methods.
   */
  async executeTool<TData = Record<string, unknown>>(
    p: ExecuteToolParams,
  ): Promise<ExecuteToolResult<TData>> {
    try {
      const out = await this.client.tools.execute(p.toolSlug, {
        userId: p.userId,
        arguments: p.arguments,
      });
      return {
        successful: Boolean(out.successful),
        data: (out.data ?? {}) as TData,
        error: out.error ?? undefined,
      };
    } catch (e) {
      throw wrapError(e, `execute-tool(${p.toolSlug})`);
    }
  }

  /**
   * Create a Composio trigger instance for `userId`. The trigger fires when
   * the provider event named by `slug` occurs (e.g. GMAIL_NEW_GMAIL_MESSAGE).
   * Composio POSTs the payload to whatever webhook URL is configured on the
   * Composio account; the URL is global per Composio account, not per
   * trigger, so it's set up once via the dashboard/SDK and reused.
   *
   * Returns the trigger id; the framework should persist it so it can later
   * call `deleteTrigger(id)` to unsubscribe.
   */
  async createTrigger(p: {
    userId: string;
    slug: string;
    triggerConfig?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    try {
      const out = await this.client.triggers.create(p.userId, p.slug, {
        triggerConfig: p.triggerConfig,
      } as never);
      const id = (out as { id?: string; triggerId?: string }).id ?? (out as { triggerId?: string }).triggerId;
      if (!id) {
        throw new ComposioSubstrateError(
          'unknown',
          `composio.create-trigger(${p.slug}): SDK returned no trigger id`,
        );
      }
      return { id };
    } catch (e) {
      throw wrapError(e, `create-trigger(${p.slug})`);
    }
  }

  /**
   * Delete a previously-created trigger instance. Called when the operator
   * switches an agent off event-mode or disables the agent entirely.
   */
  async deleteTrigger(triggerId: string): Promise<void> {
    try {
      await this.client.triggers.delete(triggerId);
    } catch (e) {
      throw wrapError(e, `delete-trigger(${triggerId})`);
    }
  }
}

// -----------------------------------------------------------------------------
// Error mapping
// -----------------------------------------------------------------------------

function wrapError(e: unknown, op: string): ComposioSubstrateError {
  if (e instanceof ComposioSubstrateError) return e;
  if (e instanceof ComposioError) {
    const kind = classifyComposioError(e);
    return new ComposioSubstrateError(kind, `composio.${op}: ${e.message}`, { cause: e });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new ComposioSubstrateError('unknown', `composio.${op}: ${msg}`, { cause: e });
}

function classifyComposioError(e: ComposioError): ComposioSubstrateError['kind'] {
  // Match by class name rather than `instanceof` chain so we don't have to
  // import the entire error taxonomy at module top.
  switch (e.name) {
    case 'ComposioAuthConfigNotFoundError':
      return 'auth-config-not-found';
    case 'ComposioConnectedAccountNotFoundError':
      return 'connection-not-found';
    case 'ConnectionRequestTimeoutError':
      return 'connection-timeout';
    case 'ComposioToolNotFoundError':
      return 'tool-not-found';
    case 'ComposioToolExecutionError':
      return 'tool-execution-failed';
    default:
      // HTTP 429 surfaces as a generic ComposioError with status on cause.
      const cause = (e as { cause?: { status?: number } }).cause;
      if (cause?.status === 429) return 'rate-limited';
      return 'unknown';
  }
}
