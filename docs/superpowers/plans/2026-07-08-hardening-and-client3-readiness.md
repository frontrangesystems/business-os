# Hardening + Client-#3 Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Tier 1 security/CI gaps found in the 2026-07-08 review (CI test signal, rate limiting, security headers, audit-log gating) and land the two pre-client-#3 items (boot-time admin bootstrap, changesets release automation).

**Architecture:** All framework changes live in `packages/core` (Fastify plugins + route/preHandler edits + a new boot step) plus two GitHub Actions workflows. One UI change in `packages/ui`. Everything is business-agnostic — nothing client-specific. **No gated check-ins:** the PR test workflow is informational only (no branch protection). The single intentional gate is in `publish.yml` — a package that fails its own tests does not publish (Matt approved this specific gate on 2026-07-08).

**Tech Stack:** Fastify 4 (`@fastify/rate-limit@^9`, `@fastify/helmet@^11`), Drizzle, Vitest against real Postgres, GitHub Actions, `@changesets/cli`.

---

## Standing conventions for every task (from CLAUDE.md + memory)

- One feature branch + one PR per task. Squash-merge the PR yourself when CI is green — do not ask Matt to review (memory: `feedback_autonomous_pr_workflow`).
- Commit prefixes are `Feat:` / `Fix:` / `Chore:` / `Spec:` (project convention — NOT lowercase `feat:`).
- **Never** add `Co-Authored-By: Claude` or "Generated with Claude Code" to commits or PR bodies (memory: `feedback_no_claude_attribution`).
- Any task that changes `packages/core` or `packages/ui` must bump that package's `version` in the same PR — the publish workflow only publishes bumped versions. Version numbers below assume the tasks merge in order; if order changes, use "current + 1".
- Integration tests need Postgres. Locally: shared dev postgres on port 5433 or the compose default `postgres://businessos:businessos@localhost:4732/businessos_dev` (see `packages/core/test/_db.ts:4-7`); tests skip gracefully when unreachable, so **confirm they actually ran** (look for the suite in vitest output, not just "0 failed").
- UI-visible changes (Tasks 4, 5): verify locally in the frs-os container before the PR (memory: `feedback_local_first_workflow`).

---

### Task 1: CI test workflow (informational — no gate)

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Baseline — run the suite twice locally**

Run: `pnpm test` (from repo root), twice.
Expected: all suites pass both times. If a test fails only sometimes, note it — memory `reference_local_dev_infra` has a known-flakes list. Flaky tests don't block this task (the workflow is informational), but list any observed flakes in the PR description so red Xs are interpretable.

- [ ] **Step 2: Confirm which env var the integration tests read**

Run: `grep -rn "TEST_DATABASE_URL" packages/*/test/ agents/*/test/ connectors/*/test/ 2>/dev/null | grep -v node_modules`
Expected: helpers resolve `TEST_DATABASE_URL` first (e.g. `packages/core/test/_db.ts:4`). If any suite reads only `DATABASE_URL`, set both env vars in Step 3's workflow (same value) — do not change the test helper in this task.

- [ ] **Step 3: Create the workflow**

Create `.github/workflows/test.yml`:

```yaml
name: Tests

# Informational only — there is NO branch protection and merges are never
# blocked. A red X means the suite fails; whether to merge anyway is a
# judgment call, not a gate. (Decision: Matt, 2026-07-08 — no gated checkins.)
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: businessos
          POSTGRES_PASSWORD: businessos
          POSTGRES_DB: businessos_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U businessos"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        env:
          TEST_DATABASE_URL: postgres://businessos:businessos@localhost:5432/businessos_test
        run: pnpm test
```

- [ ] **Step 4: Commit and open the PR**

```bash
git checkout -b ci-test-workflow
git add .github/workflows/test.yml
git commit -m "Chore: add informational CI test workflow (typecheck + tests on PRs)"
git push -u origin ci-test-workflow
gh pr create --title "Chore: informational CI test workflow" --body "Runs pnpm typecheck + pnpm test (real Postgres service) on PRs and pushes to main. Informational only — no branch protection, nothing blocks merges."
```

- [ ] **Step 5: Verify the workflow actually runs green on the PR itself**

Run: `gh pr checks --watch`
Expected: the `test` job passes. Crucially, open the job log and confirm the integration suites RAN (search the log for `auth routes (real Postgres)`) rather than skipped — a green run of skipped suites is a false signal. If they skipped, the Postgres service env is wrong; fix before merging.

- [ ] **Step 6: Squash-merge**

Run: `gh pr merge --squash --delete-branch`

---

### Task 2: Test gate on the publish workflow (the ONE agreed gate)

**Files:**
- Modify: `.github/workflows/publish.yml` (job `publish`, between the Build step at line 41-42 and the Publish step at line 44)

- [ ] **Step 1: Add the Postgres service to the publish job**

In `.github/workflows/publish.yml`, inside `jobs.publish` (after `permissions:`, before `steps:`), add:

```yaml
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: businessos
          POSTGRES_PASSWORD: businessos
          POSTGRES_DB: businessos_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U businessos"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
```

- [ ] **Step 2: Add the test step between Build and Publish**

After the `Build` step, add:

```yaml
      - name: Test publishable packages (gate — a package that fails its own tests does not publish)
        env:
          TEST_DATABASE_URL: postgres://businessos:businessos@localhost:5432/businessos_test
        run: pnpm exec turbo run test --filter "@frontrangesystems/business-os-*"
```

Scope note: the `--filter` keeps client-shell test failures (clients/* are not published) from blocking a framework publish.

- [ ] **Step 3: Update the header comment in publish.yml**

Extend the comment block at the top (lines 3-11) with one line:

```yaml
# Tests run before publish: if the suite fails, nothing publishes. This is
# the only gate in the pipeline (merges themselves are never blocked).
```

- [ ] **Step 4: Commit, PR, verify, merge**

```bash
git checkout -b publish-test-gate
git add .github/workflows/publish.yml
git commit -m "Chore: run tests before publish — failing packages don't ship"
git push -u origin publish-test-gate
gh pr create --title "Chore: test gate on publish workflow" --body "Publish now runs the framework test suite first. Merges stay ungated; only the publish step is conditional on green tests (agreed 2026-07-08)."
gh pr merge --squash --delete-branch
```

After merge, watch the main-branch publish run (`gh run watch`) and confirm the new test step passed and packages still published/skipped as before.

---

### Task 3: Rate limiting (global + strict auth routes)

**Files:**
- Modify: `packages/core/package.json` (add dep; bump version 0.0.21 → 0.0.22)
- Modify: `packages/core/src/app.ts` (AppDeps + plugin registration + healthz/readyz opt-out)
- Modify: `packages/core/src/routes/auth.ts` (per-route limits on login + password reset)
- Modify: `packages/core/test/auth.integration.test.ts`, `packages/core/test/admin.integration.test.ts`, and any other core test file calling `buildApp` (add `rateLimit: false`)
- Test: `packages/core/test/rate-limit.integration.test.ts` (new)

Design (locked): `@fastify/rate-limit@^9` (the Fastify-4-compatible major), in-memory store keyed per IP — fine because each install is a single API machine; `trustProxy: true` is already set in `app.ts:136` so `req.ip` is the real client IP behind Fly's proxy. Limits: global 300/min per IP; `/auth/login` 10/min; `/auth/password-reset/request` 5 per 15 min; `/auth/password-reset/complete` 10 per 15 min. Health probes exempt (Fly polls them constantly). Tests can switch it off via a new `AppDeps.rateLimit?: boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/rate-limit.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createSecretsStore } from '../src/secrets/index.js';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;

d('rate limiting (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    env = await freshDb();
    const encryptionKey = new Uint8Array(randomBytes(32));
    app = buildApp({
      db: env.db,
      secrets: createSecretsStore(env.db, encryptionKey),
      encryptionKey,
      clientSlug: 'test',
      logger: false,
      serveUi: false,
      // rateLimit deliberately left ON — this file tests it.
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await env.sql.end({ timeout: 1 });
  });

  it('returns 429 with the standard error shape after 10 login attempts', async () => {
    let last: { statusCode: number; body: string } = { statusCode: 0, body: '' };
    for (let i = 0; i < 11; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@example.com', password: 'wrong-password-here' },
      });
      last = { statusCode: r.statusCode, body: r.body };
    }
    expect(last.statusCode).toBe(429);
    expect(JSON.parse(last.body).error).toBe('rate_limited');
  });

  it('never rate-limits /healthz (Fly polls it constantly)', async () => {
    for (let i = 0; i < 320; i++) {
      const r = await app.inject({ method: 'GET', url: '/healthz' });
      expect(r.statusCode).toBe(200);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @frontrangesystems/business-os-core test -- rate-limit`
Expected: FAIL — 11th login returns 401 (no limiter yet), healthz test passes vacuously.

- [ ] **Step 3: Add the dependency**

Run: `pnpm --filter @frontrangesystems/business-os-core add @fastify/rate-limit@^9.1.0`

- [ ] **Step 4: Register the plugin in app.ts**

In `packages/core/src/app.ts`, add the import at the top:

```ts
import fastifyRateLimit from '@fastify/rate-limit';
```

Add to the `AppDeps` interface (after `serveUi`):

```ts
  /**
   * Register @fastify/rate-limit (default true). Test files that hammer
   * endpoints pass false; the dedicated rate-limit test leaves it on.
   */
  rateLimit?: boolean;
```

Immediately after the `fastifyMultipart` registration block (`app.ts:186-193`), add:

```ts
  // Global per-IP rate limiting. trustProxy is on above, so req.ip is the real
  // client IP behind Fly's proxy. Auth routes carry stricter per-route
  // overrides (routes/auth.ts); health probes opt out via config below.
  if (deps.rateLimit !== false) {
    void app.register(fastifyRateLimit, {
      max: 300,
      timeWindow: '1 minute',
      errorResponseBuilder: (_req, context) => ({
        error: 'rate_limited',
        retryAfterMs: context.ttl,
      }),
    });
  }
```

Change the two health routes to opt out:

```ts
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));

  app.get('/readyz', { config: { rateLimit: false } }, async (req, reply) => {
```

(the `/readyz` body stays exactly as it is).

- [ ] **Step 5: Add per-route limits in auth.ts**

In `packages/core/src/routes/auth.ts`, change the three route declarations (handlers untouched):

```ts
  app.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
```

```ts
  app.post('/auth/password-reset/request', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
```

```ts
  app.post('/auth/password-reset/complete', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
```

- [ ] **Step 6: Opt existing test files out**

Run: `grep -ln "buildApp" packages/core/test/*.ts`
For every listed file EXCEPT the new `rate-limit.integration.test.ts`, add `rateLimit: false,` to the `buildApp({...})` options (next to `logger: false`). Expected files: `auth.integration.test.ts`, `admin.integration.test.ts`, plus any users/modules integration files the grep surfaces. Without this, the admin suite (hundreds of injects per minute) trips the global 300/min limit.

- [ ] **Step 7: Run the full core suite**

Run: `pnpm --filter @frontrangesystems/business-os-core test`
Expected: ALL suites pass, including the new rate-limit file. If the 429 test fails with 401 on the 11th attempt, the per-route config isn't being picked up — confirm the plugin registers BEFORE `registerAuthRoutes(app)` in `buildApp` (declaration order matters for Fastify's onRoute hook; the multipart plugin at `app.ts:186` follows the same pattern and works).

- [ ] **Step 8: Bump version, commit, PR, merge**

In `packages/core/package.json`: `"version": "0.0.22"`.

```bash
git checkout -b rate-limiting
git add packages/core pnpm-lock.yaml
git commit -m "Feat: rate limiting — global 300/min per IP, strict limits on login and password reset"
git push -u origin rate-limiting
gh pr create --title "Feat: rate limiting on API + auth brute-force protection" --body "Adds @fastify/rate-limit: global 300/min per IP, /auth/login 10/min, password-reset 5 per 15min. Health probes exempt. Tests can disable via AppDeps.rateLimit=false. core 0.0.22."
gh pr merge --squash --delete-branch
```

---

### Task 4: Security headers (@fastify/helmet)

**Files:**
- Modify: `packages/core/package.json` (add dep; bump version 0.0.22 → 0.0.23)
- Modify: `packages/core/src/app.ts`
- Test: `packages/core/test/security-headers.integration.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/security-headers.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createSecretsStore } from '../src/secrets/index.js';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;

d('security headers (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    env = await freshDb();
    const encryptionKey = new Uint8Array(randomBytes(32));
    app = buildApp({
      db: env.db,
      secrets: createSecretsStore(env.db, encryptionKey),
      encryptionKey,
      clientSlug: 'test',
      logger: false,
      serveUi: false,
      rateLimit: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await env.sql.end({ timeout: 1 });
  });

  it('sets baseline security headers on every response', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @frontrangesystems/business-os-core test -- security-headers`
Expected: FAIL — headers undefined.

- [ ] **Step 3: Add the dependency and register it**

Run: `pnpm --filter @frontrangesystems/business-os-core add @fastify/helmet@^11.1.1`

In `packages/core/src/app.ts`, add the import:

```ts
import fastifyHelmet from '@fastify/helmet';
```

Register it directly above the rate-limit block added in Task 3:

```ts
  // Security headers. CSP is tuned for the operator UI bundle served by
  // registerUiServe: everything same-origin, inline styles allowed (React
  // style props), data: images (TOTP-enrollment QR code). frame-ancestors
  // 'none' replaces X-Frame-Options. HSTS comes from helmet defaults —
  // browsers ignore it over plain http in dev.
  void app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
```

- [ ] **Step 4: Run the full core suite**

Run: `pnpm --filter @frontrangesystems/business-os-core test`
Expected: PASS everywhere.

- [ ] **Step 5: Verify the real UI still works under the CSP (local-first — do NOT skip)**

Build and run in the local frs-os container (memory: `feedback_local_first_workflow`, `reference_local_dev_infra`), then in a browser:
1. Log in — page renders, no CSP violations in the devtools console.
2. Open Settings → TOTP enrollment — the QR code image renders (this is the `img-src data:` case).
3. Navigate Dashboard, Agents, an agent run detail — no console CSP errors.
4. `curl -sI http://localhost:<port>/healthz | grep -i -e content-security -e x-content-type` shows the headers.

If the console shows a blocked resource, extend the specific directive (e.g. `scriptSrc` needs `'unsafe-inline'` only if the UI bundle actually inlines scripts — check what's blocked, don't preemptively loosen).

- [ ] **Step 6: Bump version, commit, PR, merge**

In `packages/core/package.json`: `"version": "0.0.23"`.

```bash
git checkout -b security-headers
git add packages/core pnpm-lock.yaml
git commit -m "Feat: security headers via @fastify/helmet (CSP, nosniff, frame-ancestors, HSTS)"
git push -u origin security-headers
gh pr create --title "Feat: security headers" --body "Adds @fastify/helmet with a CSP tuned for the operator UI (verified locally incl. TOTP QR). core 0.0.23."
gh pr merge --squash --delete-branch
```

---

### Task 5: Gate GET /api/audit to admin (API + UI)

**Files:**
- Modify: `packages/core/src/routes/admin.ts:1783` (add role check; bump core 0.0.23 → 0.0.24)
- Modify: `packages/ui/src/components/Shell.tsx:159` (hide nav item)
- Modify: `packages/ui/src/app.tsx:103` (wrap route in RequireAdmin)
- Modify: `packages/ui/package.json` (bump 0.0.21 → 0.0.22)
- Test: `packages/core/test/admin.integration.test.ts` (add two cases)

Blast-radius check (already done during planning): the only UI consumer of `GET /api/audit` is `AuditPage` via `Api.listAudit` (`packages/ui/src/lib/api.ts:320-338`). `RunDetail.tsx` gets its audit trail embedded in `GET /api/runs/:id` — unaffected.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/admin.integration.test.ts`, add a describe block (reuse the file's existing app/db setup and its login helper if one exists; otherwise this self-contained block works with `createUser` from `../src/auth/users.js` and `userRoles` from `@frontrangesystems/business-os-db`):

```ts
  describe('GET /api/audit role gating', () => {
    it('403s a non-admin user', async () => {
      await createUser(env.db, { email: 'viewer@example.com', password: 'a-viewer-password-1' });
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'viewer@example.com', password: 'a-viewer-password-1' },
      });
      const cookie = login.headers['set-cookie'] as string;
      const r = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } });
      expect(r.statusCode).toBe(403);
    });

    it('200s an admin user', async () => {
      const admin = await createUser(env.db, { email: 'auditadmin@example.com', password: 'an-admin-password-1' });
      await env.db.insert(userRoles).values({ userId: admin.id, role: 'admin' });
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'auditadmin@example.com', password: 'an-admin-password-1' },
      });
      const cookie = login.headers['set-cookie'] as string;
      const r = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toHaveProperty('entries');
    });
  });
```

- [ ] **Step 2: Run to confirm the 403 case fails**

Run: `pnpm --filter @frontrangesystems/business-os-core test -- admin`
Expected: FAIL — non-admin gets 200 today.

- [ ] **Step 3: Add the role check**

`packages/core/src/routes/admin.ts:1783` — change:

```ts
  app.get('/api/audit', { preHandler: requireUser }, async (req) => {
```

to:

```ts
  app.get('/api/audit', { preHandler: [requireUser, requireRole('admin')] }, async (req) => {
```

(`requireRole` is already imported in this file — it's used on 20+ routes above.)

- [ ] **Step 4: Run core tests**

Run: `pnpm --filter @frontrangesystems/business-os-core test`
Expected: PASS.

- [ ] **Step 5: UI — hide the nav item and guard the route**

`packages/ui/src/components/Shell.tsx:159` — change:

```tsx
          <NavItem to="/audit">Audit log</NavItem>
```

to (matching the Modules/Users pattern on the lines below it):

```tsx
          {isAdmin && <NavItem to="/audit">Audit log</NavItem>}
```

`packages/ui/src/app.tsx:103` — change:

```tsx
                    <Route path="audit" element={<AuditPage />} />
```

to (match how the existing admin-only routes in this file wrap their element; `RequireAdmin` is exported from `../lib/auth`):

```tsx
                    <Route path="audit" element={<RequireAdmin><AuditPage /></RequireAdmin>} />
```

Add `RequireAdmin` to the existing import from `./lib/auth` if it isn't already there.

- [ ] **Step 6: Typecheck + local verify**

Run: `pnpm --filter @frontrangesystems/business-os-ui typecheck && pnpm --filter @frontrangesystems/business-os-ui build`
Then in the local frs-os container: as an admin the Audit log nav item works; as a non-admin user the nav item is gone and hitting `/audit` directly redirects to the dashboard.

- [ ] **Step 7: Bump versions, commit, PR, merge**

`packages/core/package.json` → `"version": "0.0.24"`; `packages/ui/package.json` → `"version": "0.0.22"`.

```bash
git checkout -b gate-audit-log
git add packages/core packages/ui
git commit -m "Fix: audit log is admin-only — gate GET /api/audit and hide the UI entry for non-admins"
git push -u origin gate-audit-log
gh pr create --title "Fix: gate audit log to admins" --body "GET /api/audit now requires the admin role (was: any authenticated user). Nav item hidden + route guarded for non-admins. RunDetail unaffected (uses /api/runs/:id). core 0.0.24, ui 0.0.22."
gh pr merge --squash --delete-branch
```

---

### Task 6: Boot-time admin bootstrap (kills the SSH `node -e` ritual)

**Files:**
- Create: `packages/core/src/boot/bootstrap-admin.ts`
- Modify: `packages/core/src/boot/env.ts:12-26` (two optional env vars)
- Modify: `packages/core/src/boot/start.ts` (call after the agent-enabled seed, ~line 191; bump core 0.0.24 → 0.0.25)
- Modify: `templates/client-starter/README.md.tmpl` (document the two vars next to the existing `SECRETS_KEY` documentation)
- Test: `packages/core/test/bootstrap-admin.integration.test.ts` (new)

Design (locked): runs on every boot, acts only when BOTH `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` are set AND the users table is EMPTY. So it can never touch an install with existing users (C&M is automatically safe), re-boots are no-ops, and there is no manual step (memory: `feedback_no_manual_fixes`). Operator flow for a new client: `fly secrets set BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_PASSWORD=...` before first deploy, log in, then `fly secrets unset` both. Email must be real-format — the login contract validates `z.email()`, which is exactly the seed-dev `admin@localhost` bug (memory: `project_seed_admin_email_bug`).

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/bootstrap-admin.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import { users, userRoles } from '@frontrangesystems/business-os-db';
import { bootstrapAdminIfNeeded } from '../src/boot/bootstrap-admin.js';
import { verifyEmailPassword } from '../src/auth/users.js';
import { freshDb, pgReachable, TEST_DATABASE_URL } from './_db.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const d = reachable ? describe : describe.skip;
const log = pino({ enabled: false });

d('bootstrap admin (real Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDb>>;

  beforeAll(async () => {
    env = await freshDb();
  });

  afterAll(async () => {
    await env.sql.end({ timeout: 1 });
  });

  it('no-ops when env vars are absent', async () => {
    await bootstrapAdminIfNeeded(env.db, {}, log);
    const rows = await env.db.select({ id: users.id }).from(users);
    expect(rows.length).toBe(0);
  });

  it('creates the first admin (login-able, admin role, audited) when the table is empty', async () => {
    await bootstrapAdminIfNeeded(
      env.db,
      { email: 'ops@frontrangesystems.com', password: 'a-long-bootstrap-pass' },
      log,
    );
    const user = await verifyEmailPassword(env.db, 'ops@frontrangesystems.com', 'a-long-bootstrap-pass');
    expect(user).not.toBeNull();
    const roles = await env.db.select().from(userRoles).where(eq(userRoles.userId, user!.id));
    expect(roles.map((r) => r.role)).toContain('admin');
    const audits = await env.sql`SELECT action FROM audit_log WHERE action = 'system.admin.bootstrapped'`;
    expect(audits.length).toBe(1);
  });

  it('never acts once any user exists (re-boot and changed-env safe)', async () => {
    await bootstrapAdminIfNeeded(
      env.db,
      { email: 'second@frontrangesystems.com', password: 'another-long-pass' },
      log,
    );
    const rows = await env.db.select({ id: users.id }).from(users);
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter @frontrangesystems/business-os-core test -- bootstrap-admin`
Expected: FAIL — module `../src/boot/bootstrap-admin.js` doesn't exist.

- [ ] **Step 3: Implement bootstrap-admin.ts**

Create `packages/core/src/boot/bootstrap-admin.ts`:

```ts
import type { Logger } from 'pino';
import type { Db } from '@frontrangesystems/business-os-db';
import { users, userRoles } from '@frontrangesystems/business-os-db';
import { createUser } from '../auth/users.js';
import { audit } from '../audit/index.js';

/**
 * First-boot admin bootstrap. Runs on every boot but only acts when BOTH
 * values are present AND the users table is empty — it can never touch an
 * install that already has users, and re-boots are no-ops. Operator flow for
 * a fresh install: set BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD as
 * deploy secrets, boot, log in, then unset both secrets.
 *
 * The email must be a real-format address — the login contract validates
 * z.email(), so values like admin@localhost can be created but never log in.
 */
export async function bootstrapAdminIfNeeded(
  db: Db,
  opts: { email?: string; password?: string },
  log: Logger,
): Promise<void> {
  if (!opts.email || !opts.password) return;

  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) {
    log.debug('bootstrap-admin: users exist; skipping');
    return;
  }

  const user = await createUser(db, {
    email: opts.email,
    password: opts.password,
    displayName: 'Admin',
  });
  await db.insert(userRoles).values({ userId: user.id, role: 'admin' });
  await audit(
    { db, requestId: 'boot', userId: null },
    'system.admin.bootstrapped',
    { email: user.email, userId: user.id },
  );
  log.warn(
    { email: user.email },
    'bootstrap-admin: first admin created — unset BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD secrets now',
  );
}
```

Before running: confirm the `audit()` signature in `packages/core/src/audit/index.ts` matches `(ctx: {db, requestId, userId}, action, meta)` — that's how `app.ts:144-151` calls it. Adjust the call if the ctx shape differs.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @frontrangesystems/business-os-core test -- bootstrap-admin`
Expected: PASS (all three cases).

- [ ] **Step 5: Add the env vars to the framework env contract**

In `packages/core/src/boot/env.ts`, inside `FrameworkEnvSchema` (after `SENTRY_DSN`):

```ts
  /** First-boot admin bootstrap — only consulted while the users table is empty. */
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
```

- [ ] **Step 6: Wire into startServer**

In `packages/core/src/boot/start.ts`, add the import:

```ts
import { bootstrapAdminIfNeeded } from './bootstrap-admin.js';
```

After the `seedAgentEnabledIfNeeded` block (line ~191, right after the closing `}` of `if (opts.inventory) {...}`), add:

```ts
  // First-boot admin: no-op unless BOOTSTRAP_ADMIN_* env is set AND zero users.
  await bootstrapAdminIfNeeded(
    db,
    { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD },
    log,
  );
```

- [ ] **Step 7: Document in the client-starter template**

In `templates/client-starter/README.md.tmpl`, find where `SECRETS_KEY` is documented (grep the file) and add alongside it:

```markdown
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (first deploy only) — when set
  and the users table is empty, boot creates this admin account. Must be a real
  email format (the login form validates it). Unset both secrets after first login.
```

- [ ] **Step 8: Full suite, bump, commit, PR, merge**

Run: `pnpm --filter @frontrangesystems/business-os-core test && pnpm --filter @frontrangesystems/business-os-core typecheck`
`packages/core/package.json` → `"version": "0.0.25"`.

```bash
git checkout -b bootstrap-admin
git add packages/core templates/client-starter
git commit -m "Feat: boot-time admin bootstrap via BOOTSTRAP_ADMIN_* env — no more SSH node -e"
git push -u origin bootstrap-admin
gh pr create --title "Feat: prod-safe first-boot admin bootstrap" --body "startServer creates the first admin from BOOTSTRAP_ADMIN_EMAIL/PASSWORD iff the users table is empty. Idempotent, audited, no-op on existing installs. core 0.0.25."
gh pr merge --squash --delete-branch
```

After merge: update memory file `project_user_mgmt_backlog.md` — the bootstrap half of that backlog item is done (operator UI for users already exists; verify and trim the memory accordingly).

---

### Task 7: Changesets release automation

**Files:**
- Create: `.changeset/config.json` (via init)
- Create: `.github/workflows/version.yml`
- Modify: root `package.json` (dev dep)
- Modify: `.github/workflows/publish.yml` (header comment only)

Design (locked): changesets manages version bumps + changelogs; the EXISTING `publish.yml` stays the publisher (it already publishes any bumped version on main). `changesets/action` only opens/refreshes a "Version Packages" PR — merging that PR is what triggers publish. Manual bumps keep working during/after migration, so this is additive, not a flag-day. No gates introduced.

- [ ] **Step 1: Install and init**

```bash
pnpm add -w -D @changesets/cli@^2.27.0
pnpm exec changeset init
```

- [ ] **Step 2: Configure**

Overwrite `.changeset/config.json` with:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "privatePackages": { "version": false, "tag": false }
}
```

Then verify the client shells are excluded: `grep '"private"' clients/*/package.json` — both clients must have `"private": true` (that's what `privatePackages` keys off). If either is missing it, add `"private": true` to that client's package.json in this PR.

- [ ] **Step 3: Create the version-PR workflow**

Create `.github/workflows/version.yml`:

```yaml
name: Version Packages

# When changeset files land on main, open/refresh a "Version Packages" PR that
# applies the bumps + changelogs. Merging THAT PR triggers publish.yml, which
# publishes anything whose version isn't on the registry yet. The PR is a
# convenience, not an approval step — no gates anywhere in this chain.
on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  version:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Create or update Version Packages PR
        uses: changesets/action@v1
        with:
          title: "Chore: version packages"
          commit: "Chore: version packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: Update the publish.yml header comment**

Replace lines 8-11 of `.github/workflows/publish.yml` ("To release a new version...") with:

```yaml
# To release: add a changeset in your PR (`pnpm exec changeset`). When it
# merges, the Version Packages workflow opens/refreshes a PR with the bumps;
# merging that PR triggers this workflow. Manually bumping package.json in a
# feature PR still works too — this workflow publishes any not-yet-on-registry
# version either way.
```

- [ ] **Step 5: Commit, PR (with a changeset exercising the flow), merge**

```bash
git checkout -b changesets-release
pnpm exec changeset  # pick @frontrangesystems/business-os-core, patch, summary: "changesets release automation dry-run"
git add .changeset .github/workflows package.json pnpm-lock.yaml
git commit -m "Chore: changesets-based release automation (version PR + existing publish flow)"
git push -u origin changesets-release
gh pr create --title "Chore: changesets release automation" --body "Adds @changesets/cli + a Version Packages workflow. Existing publish.yml stays the publisher; manual bumps still work. Includes one patch changeset for core as a live dry-run of the whole chain."
gh pr merge --squash --delete-branch
```

- [ ] **Step 6: Verify the whole chain end-to-end**

After merge: the Version Packages workflow should open a PR bumping core (0.0.25 → 0.0.26) with a changelog entry. Merge it (`gh pr merge --squash`), then watch publish.yml publish core 0.0.26 (`gh run watch`). If the version PR doesn't appear, check the workflow run log — the usual cause is the repo setting "Allow GitHub Actions to create and approve pull requests" being off (Settings → Actions → General); enable it and re-run.

---

### Task 8: Roll out to C&M (client repo — after Tasks 3–6 are published)

**Files (in `github.com/frontrangesystems/c-and-m-construction-os`, NOT this monorepo):**
- Modify: `package.json` (bump `@frontrangesystems/business-os-core` pin to the final published version from Tasks 3–6, `@frontrangesystems/business-os-ui` to 0.0.22 — remember caret on 0.0.x is exact, so the number must be edited)
- Modify: `pnpm-lock.yaml` (via install)

- [ ] **Step 1: Bump pins and validate the lockfile the way Docker will see it**

In the client repo: edit both pins, then `pnpm install`, then validate with `pnpm install --frozen-lockfile --ignore-workspace` (memory `project_client_lockfile_drift` — the monorepo workspace masks stale client lockfiles and the Docker frozen install is what actually breaks).

- [ ] **Step 2: Also check the monorepo's dev copy**

`clients/c-and-m-construction-os/package.json` in THIS repo: if its framework deps are pinned versions (not `workspace:*`), bump them to match so local dev doesn't drift from the deployed client.

- [ ] **Step 3: Deploy to staging and verify each hardening item live**

Push to the `staging` branch (branch-per-env CI/CD, memory `project_cm_cicd`). On the staging URL:
1. `curl -sI https://<staging-host>/healthz | grep -i content-security` → headers present.
2. 11 rapid bad logins → 11th returns 429 (then wait a minute so you can log in yourself).
3. Log in as a non-admin (or temporarily create one) → no Audit log nav; `GET /api/audit` returns 403.
4. Check logs for the boot line — bootstrap-admin should log nothing (users exist; correct no-op).
5. Confirm the worker still processes jobs (autostop gotcha, memory `project_prospector_rollout`).

- [ ] **Step 4: Promote to prod**

Merge staging → main in the client repo (triggers prod deploy). Re-run the curl header check and one 429 check against prod. Done.

---

## Explicitly out of scope (decided 2026-07-08 — don't do these here)

- Branch protection / required status checks of any kind (Matt: no gated check-ins).
- Sliding session expiry, `SECRETS_KEY` rotation runbook, `admin.ts` split, ESLint boundary enforcement, digest agent tests — all Tier 2/3, batch later.
- Any multi-tenant, SSO, or scale work (locked out of scope in CLAUDE.md).
