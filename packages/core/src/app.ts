import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@frontrangesystems/business-os-db';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerUiServe } from './ui-serve.js';
import { registerFastifySentry } from './sentry.js';
import { registerModuleRoutes } from './modules.js';
import type { SecretsStore } from './secrets/index.js';
import { audit, type AuditContext } from './audit/index.js';
import type {
  AgentInventory,
  ManualTriggerer,
  ExternalOAuthBrokerLike,
} from './inventory.js';

export const SESSION_COOKIE = 'bos_sess';

export interface AppDeps {
  db: Db;
  secrets: SecretsStore;
  /** 32-byte symmetric key used to encrypt TOTP secrets at rest. */
  encryptionKey: Uint8Array;
  clientSlug: string;
  /** Brand name shown in TOTP enrollment. Defaults to "Business OS". */
  issuer?: string;
  /** Override the built-in cookie security default (true outside dev). */
  cookieSecure?: boolean;
  /** Fastify logger options. Tests pass `false` to silence. */
  logger?: boolean | { level?: string };
  /**
   * Serve @frontrangesystems/business-os-ui static assets at /. Default true outside tests.
   * Tests typically set this false to keep the app surface API-only.
   */
  serveUi?: boolean;
  /**
   * Inventory of what's registered (agents, connectors). The runtime's
   * Registry satisfies this. When omitted, admin endpoints that need it
   * return 503 — useful for tests of the auth-only surface.
   */
  inventory?: AgentInventory;
  /**
   * Manual run dispatcher. The runtime's Scheduler satisfies this. When
   * omitted, `POST /api/agents/:slug/run` returns 503.
   */
  trigger?: ManualTriggerer;
  /**
   * External OAuth brokers, keyed by provider name. The client shell
   * constructs the broker (e.g. ComposioSubstrate with the install's
   * COMPOSIO_API_KEY) and passes it here. Used by the /connect and
   * /finalize-connect routes. Omit to disable the broker-driven Connect
   * flow — Composio-backed connectors will return 503 on /connect.
   */
  externalOAuthBrokers?: {
    composio?: ExternalOAuthBrokerLike;
  };
  /**
   * Public URL of this install (e.g. https://os.cmconstruction.com or
   * http://localhost:4938 in dev). Used when constructing OAuth callback
   * URLs the broker redirects back to. Defaults to env PUBLIC_URL or the
   * Host header at request time.
   */
  publicUrl?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    deps: AppDeps;
    user?: { id: string; email: string } | null;
    audit(action: string, meta?: Record<string, unknown>): Promise<void>;
  }
}

const SELECT_ONE = sql`SELECT 1`;

function defaultLoggerOpts(clientSlug: string): Record<string, unknown> {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { client_slug: clientSlug },
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        '*.password',
        '*.totp',
        '*.token',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };
}

export function buildApp(deps: AppDeps): FastifyInstance & { deps: AppDeps } {
  const loggerOpt =
    deps.logger === false
      ? false
      : {
          ...defaultLoggerOpts(deps.clientSlug),
          ...(typeof deps.logger === 'object' ? deps.logger : {}),
        };

  const opts: FastifyServerOptions = {
    logger: loggerOpt as FastifyServerOptions['logger'],
    genReqId: (req) =>
      (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    trustProxy: true,
  };
  const app = Fastify(opts);

  app.addHook('onRequest', async (req) => {
    req.requestId = req.id as string;
    req.deps = deps;
    req.user = null;
    req.audit = async (action, meta) => {
      const ctx: AuditContext = {
        db: deps.db,
        requestId: req.requestId,
        userId: req.user?.id ?? null,
      };
      return audit(ctx, action, meta);
    };
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.requestId);
    return payload;
  });

  // Multipart/form-data support is a framework capability — any module route
  // can stream a file via `req.file()` / `req.parts()`. The plugin only engages
  // on a `multipart/form-data` content-type, so JSON routes are unaffected.
  // Limits are tuned for large bid PDFs (e.g. an 81 MB scanned plan set):
  // fileSize ~110 MB headroom above the module's ~100 MB cap; field counts kept
  // tiny since we only expect a single file part plus an optional filename.
  // We do NOT set `attachFieldsToBody` — routes consume the stream directly so
  // the file is never fully buffered in memory.
  void app.register(fastifyMultipart, {
    limits: {
      fileSize: 110 * 1024 * 1024,
      files: 1,
      fields: 4,
      fieldSize: 1024,
    },
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (req, reply) => {
    try {
      await req.deps.db.execute(SELECT_ONE);
      return { ok: true, db: 'up' };
    } catch (err) {
      req.log.error({ err }, 'readyz: db ping failed');
      reply.code(503);
      return { ok: false, db: 'down' };
    }
  });

  registerFastifySentry(app);
  registerAuthRoutes(app);
  registerAdminRoutes(app);

  // Modules go under /api/modules/<slug>. Registration is async (loads settings
  // from the DB) and must happen BEFORE Fastify's ready phase — startServer
  // awaits registerModuleRoutes(app, deps) after buildApp returns. Doing it
  // here in an onReady hook would fail with AVV_ERR_ROOT_PLG_BOOTED because
  // ready has already fired by then.

  if (deps.serveUi !== false) {
    registerUiServe(app);
  }

  // Expose deps on the app instance so callers (startServer) can re-use it
  // for late wiring like registerModuleRoutes(app, deps) before app.listen.
  (app as unknown as { deps: AppDeps }).deps = deps;
  return app as unknown as FastifyInstance & { deps: AppDeps };
}
