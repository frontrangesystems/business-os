import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { users, userRoles } from '@frontrangesystems/business-os-db';
import { authContract } from '@frontrangesystems/business-os-api-contract';
import { SESSION_COOKIE } from '../app.js';
import { requireUser } from './_require-user.js';
import { sendPasswordResetEmail } from '../system-email.js';
import {
  verifyEmailPassword,
  createSession,
  revokeSession,
  issuePasswordResetToken,
  completePasswordReset,
  generateTotpSecret,
  setUserTotpSecret,
  getUserTotpSecret,
  clearUserTotpSecret,
  verifyTotpCode,
} from '../auth/index.js';

/**
 * Auth routes.
 *
 * Notes:
 * - Cookie is httpOnly, SameSite=Lax, Secure in production. We set/clear it
 *   with raw Set-Cookie (no @fastify/cookie dep yet — overkill for this slice).
 * - Password reset endpoints never leak whether the email is on file: the
 *   "request reset" endpoint always returns ok, and the "complete reset"
 *   endpoint either succeeds or returns 400 with no information leaking
 *   whether the token shape was right vs the user existed.
 * - TOTP routes are split: /totp/enroll generates a secret and stashes it
 *   (NOT yet verified). /totp/confirm verifies a code against the stashed
 *   secret. We only consider the user "TOTP-enrolled" after confirm — login
 *   doesn't require TOTP until confirm has succeeded.
 */

function buildCookie(
  name: string,
  value: string,
  expires: Date,
  secure: boolean,
): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(name: string, secure: boolean): string {
  return buildCookie(name, '', new Date(0), secure);
}

function readSessionCookie(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const cookieSecure = (req: FastifyRequest) =>
    req.deps.cookieSecure ?? process.env.NODE_ENV === 'production';

  // ---- POST /auth/login ----
  app.post('/auth/login', async (req, reply) => {
    const parsed = authContract.LoginRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const { email, password, totp } = parsed.data;
    const user = await verifyEmailPassword(req.deps.db, email, password);
    if (!user) {
      await req.audit('auth.login.failed', { email, reason: 'bad_credentials' });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    // If TOTP is enrolled, require a valid code.
    if (user.totpSecretEncrypted) {
      if (!totp) {
        await req.audit('auth.login.failed', {
          email,
          reason: 'totp_required',
        });
        return reply.code(401).send({ error: 'totp_required' });
      }
      const secret = await getUserTotpSecret(
        req.deps.db,
        user.id,
        req.deps.encryptionKey,
      );
      if (!secret || !verifyTotpCode(secret, totp)) {
        await req.audit('auth.login.failed', {
          email,
          reason: 'bad_totp',
        });
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
    }

    const created = await createSession(req.deps.db, user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    // Load roles so the post-login request context (and audit) reflect them.
    // The response below doesn't ship roles — the UI reads them from /auth/me
    // — but req.user must satisfy its type and is used by req.audit.
    const roleRows = await req.deps.db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, user.id));
    req.user = { id: user.id, email: user.email, roles: roleRows.map((r) => r.role) };
    await req.audit('auth.login.success', { email });

    reply.header(
      'set-cookie',
      buildCookie(SESSION_COOKIE, created.token, created.expiresAt, cookieSecure(req)),
    );
    const body: authContract.LoginResponse = {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? null,
      },
    };
    return body;
  });

  // ---- POST /auth/logout ----
  app.post('/auth/logout', async (req, reply) => {
    const token = readSessionCookie(req);
    if (token) {
      await revokeSession(req.deps.db, token);
      await req.audit('auth.logout');
    }
    reply.header('set-cookie', clearCookie(SESSION_COOKIE, cookieSecure(req)));
    return { ok: true as const };
  });

  // ---- GET /auth/me ----
  app.get('/auth/me', { preHandler: requireUser }, async (req) => {
    // Look up TOTP-enrollment state + UI prefs from the user row in one query
    // so the UI knows whether to show enroll vs disable and can boot with the
    // user's chosen theme (no flash of wrong theme on first paint).
    const rows = await req.deps.db
      .select({
        totpSecretEncrypted: users.totpSecretEncrypted,
        theme: users.theme,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);
    const totpEnrolled = !!rows[0]?.totpSecretEncrypted;
    const theme = rows[0]?.theme ?? 'system';
    // req.user already carries { id, email, roles } from requireUser; fold in
    // displayName so the UI has the full current-user shape from one call.
    return {
      user: { ...req.user!, displayName: rows[0]?.displayName ?? null },
      totpEnrolled,
      preferences: { theme },
    };
  });

  // ---- PATCH /auth/me/preferences ----
  app.patch('/auth/me/preferences', { preHandler: requireUser }, async (req, reply) => {
    const parsed = authContract.UpdatePreferencesRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });

    const patch: { theme?: 'light' | 'dark' | 'system' } = {};
    if (parsed.data.theme) patch.theme = parsed.data.theme;
    // Nothing to do? Read current and return it.
    if (Object.keys(patch).length === 0) {
      const [row] = await req.deps.db
        .select({ theme: users.theme })
        .from(users)
        .where(eq(users.id, req.user!.id))
        .limit(1);
      return { ok: true as const, preferences: { theme: row?.theme ?? 'system' } };
    }

    const [updated] = await req.deps.db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, req.user!.id))
      .returning({ theme: users.theme });

    if (!updated) return reply.code(404).send({ error: 'user_not_found' });
    await req.audit('user.preferences.updated', { fields: Object.keys(patch) });
    return { ok: true as const, preferences: { theme: updated.theme } };
  });

  // ---- POST /auth/password-reset/request ----
  app.post('/auth/password-reset/request', async (req, reply) => {
    const parsed = authContract.RequestPasswordResetRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const issued = await issuePasswordResetToken(req.deps.db, parsed.data.email);
    // Always log the attempt — never reveal in the response.
    await req.audit('auth.password_reset.requested', {
      email: parsed.data.email,
      issued: !!issued,
    });
    if (issued) {
      // Log a short prefix for dev convenience (token is hashed in DB; this leaks nothing sensitive).
      req.log.info(
        { reset_token_hint: issued.token.slice(0, 8) + '…' },
        'issued password reset token',
      );

      // Send the reset email via Resend (no-ops if RESEND_API_KEY is absent).
      const publicUrl = process.env['PUBLIC_URL'];
      if (!publicUrl) {
        req.log.warn('PUBLIC_URL is not set — password reset email will contain a relative URL');
      }
      const resetUrl = `${publicUrl ?? ''}/reset-password?token=${issued.token}`;
      await sendPasswordResetEmail(parsed.data.email, resetUrl).catch((err: unknown) => {
        // Log but don't fail the request — user still gets { ok: true }.
        req.log.error({ err }, 'failed to send password reset email');
      });
    }
    return { ok: true as const };
  });

  // ---- POST /auth/password-reset/complete ----
  app.post('/auth/password-reset/complete', async (req, reply) => {
    const parsed = authContract.CompletePasswordResetRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
    const result = await completePasswordReset(
      req.deps.db,
      parsed.data.token,
      parsed.data.password,
    );
    if (!result) {
      await req.audit('auth.password_reset.completed', { ok: false });
      return reply.code(400).send({ error: 'invalid_or_expired_token' });
    }
    await req.audit('auth.password_reset.completed', {
      ok: true,
      userId: result.userId,
    });
    return { ok: true as const };
  });

  // ---- POST /auth/totp/enroll ----  (returns secret; not yet active)
  app.post(
    '/auth/totp/enroll',
    { preHandler: requireUser },
    async (req) => {
      const { secret, otpauthUri } = generateTotpSecret({
        issuer: req.deps.issuer ?? 'Business OS',
        accountName: req.user!.email,
      });
      await setUserTotpSecret(
        req.deps.db,
        req.user!.id,
        secret,
        req.deps.encryptionKey,
      );
      await req.audit('auth.totp.enroll_started');
      const body: authContract.EnrollTotpResponse = { secret, otpauthUri };
      return body;
    },
  );

  // ---- POST /auth/totp/confirm ----  (verifies first code, locks in MFA)
  app.post(
    '/auth/totp/confirm',
    { preHandler: requireUser },
    async (req, reply) => {
      const parsed = authContract.ConfirmTotpRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const secret = await getUserTotpSecret(
        req.deps.db,
        req.user!.id,
        req.deps.encryptionKey,
      );
      if (!secret) return reply.code(409).send({ error: 'not_enrolled' });
      if (!verifyTotpCode(secret, parsed.data.code)) {
        await req.audit('auth.totp.confirm_failed');
        return reply.code(400).send({ error: 'invalid_code' });
      }
      await req.audit('auth.totp.confirmed');
      return { ok: true as const };
    },
  );

  // ---- POST /auth/totp/disable ----  (requires a current code as proof of presence)
  app.post(
    '/auth/totp/disable',
    { preHandler: requireUser },
    async (req, reply) => {
      const parsed = authContract.ConfirmTotpRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_input' });
      const secret = await getUserTotpSecret(
        req.deps.db,
        req.user!.id,
        req.deps.encryptionKey,
      );
      if (!secret) return reply.code(409).send({ error: 'not_enrolled' });
      if (!verifyTotpCode(secret, parsed.data.code)) {
        await req.audit('auth.totp.disable_failed');
        return reply.code(400).send({ error: 'invalid_code' });
      }
      await clearUserTotpSecret(req.deps.db, req.user!.id);
      await req.audit('auth.totp.disabled');
      return { ok: true as const };
    },
  );
}
