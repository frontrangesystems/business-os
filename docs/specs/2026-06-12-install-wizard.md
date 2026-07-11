# Install Wizard

**Date:** 2026-06-12
**Status:** Draft. Not yet implemented.
**Related:**
- [2026-06-12-system-settings.md](2026-06-12-system-settings.md) — the settings table + UI the wizard hands off to. Companion spec.
- [2026-06-06-business-os-architecture.md](2026-06-06-business-os-architecture.md) — locked decision: per-client install, runtime config in DB managed via UI.
- `memory/project_user_mgmt_backlog.md` — first deploys of C&M staging + prod (2026-06-12) had no production-safe admin bootstrap; this spec replaces that.

---

## Context

The 2026-06-12 first deploy of `c-and-m-staging` revealed three friction points the existing system has no good answer for:

1. **No production-safe way to create the first admin user.** `seed-dev.ts` refuses to run with `NODE_ENV=production`. We bootstrapped Matt's account by SSHing into the running Fly machine and running an inline `node -e` script that called `createDb` + `hashPassword` + `db.insert(users)`. Worked once; not a process we'd hand to a client.
2. **`COMPOSIO_API_KEY` + `RESEND_API_KEY` shipped as Fly secrets.** Per CLAUDE.md, runtime credentials are supposed to live in the DB, not env. They were env vars purely because no UI exists for setting them yet.
3. **`PUBLIC_URL` shipped as a Fly secret.** Used for OAuth callbacks and password-reset email links. There's no reason an operator should ever type it — it's derivable from the first request hitting the app.

Collectively, every new client deploy requires the operator to set 4–5 env vars in addition to `DATABASE_URL`. The pitch ("install Business OS for your business") gets harder the more environment plumbing the operator sees.

## Decision

Ship a one-step install wizard at `GET /setup` that runs once per install. When `users` is empty, the wizard renders; once a user exists, the route 404s and the operator goes to `/login`.

The wizard creates the **first admin user**, period. Nothing else. After the user is created, they auto-log-in and land on `/dashboard`, which surfaces a non-blocking **Setup Checklist** banner pointing at the system-settings page for any unconfigured framework keys (Composio, Resend, Sentry).

This reduces the deploy contract to:

```
DATABASE_URL=...
SECRETS_KEY=...        # libsodium key for at-rest encryption; can't itself live in DB
```

Everything else (Composio API key, Resend API key, Sentry DSN, PUBLIC_URL, default LLM keys) is configured in the operator UI post-install, on the operator's own schedule.

## Detailed flow

### 1. Route gating

```
GET  /setup     — if (await countUsers()) === 0 → render wizard; else 404
POST /setup     — if (await countUsers()) === 0 → create admin; else 409
```

Server reads `count(*) from users` once per request — cheap (zero rows or one row, indexed PK). No caching: this route is hit once in the install's life, then never again until a DB wipe.

### 2. The form (only step)

Fields:
- **Email** — `z.string().email().max(254).transform(toLower).trim()`
- **Password** — `z.string().min(12).max(256)` (matches existing `Password` schema in `api-contract/auth.ts`)
- **Confirm password** — must equal password (client-side only; server doesn't see it twice)
- **Display name** — `z.string().min(1).max(80)`

Validation errors render inline. On submit:

```
POST /setup
{ email, password, displayName }
→ if users not empty: 409 already_initialized
→ hashPassword(password) via argon2id
→ db.insert(users).values({ email, passwordHash, displayName, role: 'admin' })
→ createSession(userId) → set session cookie
→ 303 redirect to /dashboard
→ audit('install.setup.completed', { userId, email })
```

The password field defends against autofill per [[feedback_password_field_autofill]] — this is a *new password* input, not a login. `autocomplete="new-password"`, `name="install-password"`, etc.

### 3. PUBLIC_URL auto-derive

On the first authenticated request after install, before any handler runs:

```
if (await getSystemSetting('PUBLIC_URL') === null) {
  const url = `${req.protocol}://${req.hostname}`;
  await setSystemSetting('PUBLIC_URL', url, { source: 'auto-derived', byUserId: req.user.id });
  audit('system_settings.public_url.auto_derived', { url });
}
```

Persists once. Override available in the system-settings page if the operator ever fronts the app behind a custom domain or CDN.

### 4. Setup Checklist on dashboard

After admin login, `/dashboard` renders a dismissible **Setup Checklist** card at the top. Items, with link to the corresponding setting in `/admin/settings`:

- [ ] Composio API key — needed for Gmail/Outlook/LinkedIn/etc OAuth connectors
- [ ] Resend API key — needed for password-reset emails
- [ ] Sentry DSN — needed for error reporting (optional)
- [ ] Add at least one LLM provider instance — needed for any agent that uses LLM

Each row shows ✓ (configured) or → "Configure". Dismissible per-user (stores `setupChecklistDismissed = true` in their user prefs); reappears when something becomes unconfigured.

## Why no race-condition gate

Earlier draft proposed a one-time install token printed to deploy logs (operator runs `flyctl logs | grep INSTALL_TOKEN`, types it in). Dropped after discussion 2026-06-12:

- The per-client URL (e.g. `c-and-m-staging.fly.dev`) is not announced anywhere before the operator's first visit. The race window is "between DNS-resolution by the legitimate operator and form submission" — seconds, not hours.
- Even if a stranger somehow guessed the URL, they'd need to land before the operator did. The operator owns deploy timing.
- Adding a token gate trades a real one-step flow for a multi-step CLI dance, which fights the entire point of the wizard.

If we ever observe a real race attempt, we revisit. Default to simple.

## Why no second step

Earlier draft had step 2 set Composio + Resend + Sentry + LLM keys in the wizard. Dropped:

- None of those are required to *create* an account.
- All of them are non-blocking at runtime (system boots without them; specific features stay inactive).
- Putting them in the wizard pushes the operator to make decisions before they have any feeling for what the system does.
- The Setup Checklist on the dashboard surfaces the same prompts after the operator has a chance to look around.

The wizard's job is "let the operator in." The settings page's job is "let the operator configure." Mixing them blurs both.

## Migration path

This is brownfield-safe for existing C&M staging + prod (where Matt's user already exists):

- `count(users) > 0` on the existing installs → `/setup` returns 404, business as usual.
- Existing `COMPOSIO_API_KEY` / `RESEND_API_KEY` env vars continue to work as a fallback for one upgrade cycle (handled by the companion system-settings spec).

For brand-new client installs:

- Deploy with `DATABASE_URL` + `SECRETS_KEY` only.
- Operator visits `https://<client>.fly.dev/setup`, creates their admin.
- Lands on dashboard, sees Setup Checklist, sets keys as needed.

## Dependencies

This spec assumes:

- **A `role` column on `users`** (currently absent — every user can do everything). The wizard creates the admin with `role: 'admin'`. Settings UI gates on `role = 'admin'`. Builds the user-management story off the same primitive. Add as part of this PR.
- **`system_settings` table + encrypted-at-rest storage.** Covered by [[2026-06-12-system-settings.md]].
- **A `Setup Checklist` dashboard card.** Small UI addition; reads the same system-settings store.

## Out of scope (explicit)

- Re-running the wizard after install. If you need to wipe-and-reinstall, drop the `users` table; the route re-opens. We don't ship a "reset wizard" button.
- Multi-tenant install onboarding. We're single-tenant per install; the wizard is per-deploy.
- Email-based admin invite. The first admin is created at `/setup`; subsequent admins are added through the user-management page (covered by the user-management spec, not this one).
