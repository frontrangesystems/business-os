import { createHash, randomBytes } from 'node:crypto';
import { eq, and, isNull, gt } from 'drizzle-orm';
import type { Db } from '@frontrangesystems/business-os-db';
import { sessions, users, userRoles, type User } from '@frontrangesystems/business-os-db';

/**
 * Sessions.
 *
 * - The session id we hand to the cookie is 32 random bytes hex-encoded (64 chars).
 * - In the DB we store sha256(token) under `sessions.id`. We never store the raw
 *   token. A DB leak therefore doesn't yield usable session tokens.
 * - Verification re-hashes the incoming cookie and looks up by stored hash.
 */

export const SESSION_TOKEN_BYTES = 32;
export const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export interface CreatedSession {
  /** The raw token that goes in the cookie. Server stores only its hash. */
  token: string;
  expiresAt: Date;
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
  ttlMs?: number;
}

export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('hex');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Db,
  userId: string,
  meta: SessionMeta = {},
): Promise<CreatedSession> {
  const token = newSessionToken();
  const ttl = meta.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);
  await db.insert(sessions).values({
    id: hashSessionToken(token),
    userId,
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { token, expiresAt };
}

export interface SessionLookup {
  user: User;
  /** App-level roles the user holds (e.g. ['admin']). May be empty. */
  roles: string[];
  sessionId: string;
  expiresAt: Date;
}

export async function lookupSession(db: Db, token: string): Promise<SessionLookup | null> {
  const id = hashSessionToken(token);
  const rows = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.id, id),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
        eq(users.isActive, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const roleRows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, row.user.id));
  const roles = roleRows.map((r) => r.role);

  return { user: row.user, roles, sessionId: row.sessionId, expiresAt: row.expiresAt };
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  const id = hashSessionToken(token);
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, id));
}

export async function revokeAllUserSessions(db: Db, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
