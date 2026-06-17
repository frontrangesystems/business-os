import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { userRoles } from '@frontrangesystems/business-os-db';
import { buildApp, SESSION_COOKIE } from '../src/app.js';
import { createSecretsStore } from '../src/secrets/index.js';
import { createUser } from '../src/auth/users.js';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;

if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[core.integration] Skipping users tests: Postgres unreachable at ${TEST_DATABASE_URL}. ` +
      `Start it with \`docker compose up -d postgres\` to run these.`,
  );
}

function readSetCookie(setCookie: string | string[] | undefined): string | null {
  if (!setCookie) return null;
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) return null;
  const m = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return m?.[1] ?? null;
}

const PW = 'correct-horse-battery-staple';

d('user-management routes (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let app: ReturnType<typeof buildApp>;
  const encryptionKey = new Uint8Array(randomBytes(32));

  // Cookies for an admin and a non-admin (estimator) user.
  let adminCookie = '';
  let estimatorCookie = '';
  let adminId = '';

  async function login(email: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PW },
    });
    const token = readSetCookie(r.headers['set-cookie']);
    if (!token) throw new Error(`login failed for ${email}: ${r.statusCode}`);
    return `${SESSION_COOKIE}=${token}`;
  }

  beforeAll(async () => {
    env = await freshDb();
    const secrets = createSecretsStore(env.db, encryptionKey);
    app = buildApp({
      db: env.db,
      secrets,
      encryptionKey,
      clientSlug: 'test',
      logger: false,
      serveUi: false,
    });
    await app.ready();

    const admin = await createUser(env.db, { email: 'admin@example.com', password: PW });
    adminId = admin.id;
    await env.db.insert(userRoles).values({ userId: admin.id, role: 'admin' });

    const estimator = await createUser(env.db, { email: 'est@example.com', password: PW });
    await env.db.insert(userRoles).values({ userId: estimator.id, role: 'estimator' });

    adminCookie = await login('admin@example.com');
    estimatorCookie = await login('est@example.com');
  });

  afterAll(async () => {
    await app.close();
    await env.sql.end({ timeout: 1 });
  });

  it('/auth/me exposes the user roles', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: adminCookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.roles).toContain('admin');
  });

  it('non-admin is forbidden (403) from listing users', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: estimatorCookie },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'forbidden' });
  });

  it('unauthenticated is rejected (401) from listing users', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/users' });
    expect(r.statusCode).toBe(401);
  });

  it('admin can list users with their roles', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: adminCookie },
    });
    expect(r.statusCode).toBe(200);
    const emails = r.json().users.map((u: { email: string }) => u.email);
    expect(emails).toContain('admin@example.com');
    expect(emails).toContain('est@example.com');
  });

  it('admin creates a user with roles; non-admin cannot', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: estimatorCookie },
      payload: { email: 'new@example.com', password: 'a-very-long-password', roles: ['estimator'] },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: {
        email: 'New@Example.com',
        displayName: 'New Person',
        password: 'a-very-long-password',
        roles: ['estimator'],
      },
    });
    expect(ok.statusCode).toBe(201);
    const body = ok.json();
    expect(body.user.email).toBe('new@example.com'); // normalized lowercase
    expect(body.user.roles).toEqual(['estimator']);
    expect(body.user).not.toHaveProperty('passwordHash');

    // Audit row written.
    const audit = await env.sql`
      SELECT action FROM audit_log WHERE action = 'admin.user.created' LIMIT 1
    `;
    expect(audit.length).toBe(1);
  });

  it('rejects a short password and a duplicate email', async () => {
    const short = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { email: 'short@example.com', password: 'too-short' },
    });
    expect(short.statusCode).toBe(400);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { email: 'admin@example.com', password: 'a-very-long-password' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'email_taken' });
  });

  it('rejects an unknown role', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { email: 'roley@example.com', password: 'a-very-long-password', roles: ['superuser'] },
    });
    expect(r.statusCode).toBe(400);
  });

  it('admin assigns roles to a user (replace semantics)', async () => {
    // est currently has ['estimator']; promote to ['admin','estimator'].
    const list = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: adminCookie },
    });
    const est = list.json().users.find((u: { email: string }) => u.email === 'est@example.com');
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/users/${est.id}/roles`,
      headers: { cookie: adminCookie },
      payload: { roles: ['admin', 'estimator'] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().roles.sort()).toEqual(['admin', 'estimator']);

    // Now demote back to estimator only — allowed because admin@ is still admin.
    const r2 = await app.inject({
      method: 'PATCH',
      url: `/api/users/${est.id}/roles`,
      headers: { cookie: adminCookie },
      payload: { roles: ['estimator'] },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().roles).toEqual(['estimator']);
  });

  it('last-admin guard: cannot remove admin from the only admin', async () => {
    // admin@ is the sole admin at this point. Removing its admin role must fail.
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}/roles`,
      headers: { cookie: adminCookie },
      payload: { roles: ['estimator'] },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'last_admin' });
  });

  it('last-admin guard: cannot deactivate the only admin', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { isActive: false },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'last_admin' });
  });

  it('deactivating a NON-last admin is allowed', async () => {
    // Make est an admin too, then deactivating admin@ is fine.
    const list = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: adminCookie },
    });
    const est = list.json().users.find((u: { email: string }) => u.email === 'est@example.com');
    const promote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${est.id}/roles`,
      headers: { cookie: adminCookie },
      payload: { roles: ['admin', 'estimator'] },
    });
    expect(promote.statusCode).toBe(200);

    const deact = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { cookie: adminCookie },
      payload: { isActive: false },
    });
    expect(deact.statusCode).toBe(200);
    expect(deact.json().user.isActive).toBe(false);
  });
});
