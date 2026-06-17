import type { FastifyRequest, FastifyReply } from 'fastify';
import { SESSION_COOKIE } from '../app.js';
import { lookupSession } from '../auth/sessions.js';

/**
 * Shared preHandler: requires a valid session cookie. Populates req.user.
 * Replies 401 if missing/invalid.
 */
export async function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const raw = req.headers.cookie;
  let token: string | null = null;
  if (raw) {
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === SESSION_COOKIE) {
        token = rest.join('=');
        break;
      }
    }
  }
  if (!token) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  const lookup = await lookupSession(req.deps.db, token);
  if (!lookup) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  req.user = { id: lookup.user.id, email: lookup.user.email, roles: lookup.roles };
  // Enrich the per-request logger so every line a handler emits downstream
  // carries user_id (the access line in app.ts also reads req.user directly, so
  // it's covered even on routes that don't log). req.log is already bound with
  // client_slug + request_id; this adds the authenticated principal.
  req.log = req.log.child({ user_id: lookup.user.id });
}

/**
 * preHandler factory: requires the authenticated user to hold at least ONE of
 * the listed roles. Composable as a preHandler array AFTER `requireUser`:
 *
 *   { preHandler: [requireUser, requireRole('admin')] }
 *
 * It does NOT authenticate on its own — if `req.user` is null (requireUser
 * didn't run or rejected first) it returns 401, so misordering fails closed
 * rather than letting an anonymous request through. With a user present but
 * holding none of `allowed`, it returns 403 { error: 'forbidden' }.
 */
export function requireRole(
  ...allowed: string[]
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = req.user;
    if (!user) {
      // Fail closed: requireRole must never be the sole auth gate.
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const has = user.roles.some((r) => allowed.includes(r));
    if (!has) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
  };
}
