# System Settings

**Date:** 2026-06-12
**Status:** Draft. Not yet implemented.
**Related:**
- [2026-06-12-install-wizard.md](2026-06-12-install-wizard.md) — the install flow this spec hands off to. Companion spec.
- [2026-06-06-business-os-architecture.md](2026-06-06-business-os-architecture.md) — locked decision: "All credentials, API keys, schedules, on/off, and per-agent settings live in the DB and are managed in the settings UI."

---

## Context

Three framework-level secrets currently ship as Fly env vars on every C&M deploy:

- `COMPOSIO_API_KEY` — OAuth-broker key wired into `ComposioSubstrate` at boot.
- `RESEND_API_KEY` — system mailer for password-reset emails.
- `PUBLIC_URL` — base URL used in OAuth callbacks and password-reset links.

Per CLAUDE.md, these should live in the DB and be managed from the operator UI. They're env vars only because no UI exists for them.

This spec defines:

1. The `system_settings` table — key-value store, encrypted-at-rest where applicable.
2. The `/admin/settings` page — admin-only UI for reading + updating settings.
3. Per-request resolution — how `ComposioSubstrate` etc consume settings without restart.
4. The first-boot migration that reads existing env vars into settings rows.

## Decision

Ship a generic `system_settings` table + UI that the framework owns. Any framework module that needs a configurable value declares a typed setting; the framework auto-renders the form (same pattern as agent/connector settings).

Per-request resolution at the connector layer means saved changes take effect on the next request, without restarting the app or worker process.

## Schema

```sql
-- packages/db migration
create table system_settings (
  scope         text        not null,         -- 'framework' | 'module:<slug>' | etc
  key           text        not null,
  value_encrypted bytea,                      -- libsodium crypto_secretbox(plaintext, SECRETS_KEY)
  value_plain   text,                         -- non-secret values (PUBLIC_URL, feature flags)
  updated_at    timestamptz not null default now(),
  updated_by    uuid        references users(id),
  primary key (scope, key)
);
create index on system_settings (updated_at desc);
```

A row uses either `value_encrypted` XOR `value_plain` depending on whether the setting is sensitive. Sensitive examples: API keys, OAuth client secrets. Non-sensitive examples: PUBLIC_URL, feature flags, default LLM provider slug.

Why one table for both: a setting either *is* a secret or *isn't*; nothing in between. The schema makes that choice explicit per-row, and a single table simplifies the audit log, the UI, and migrations.

## Setting declarations

Each framework module exports a typed setting declaration. The framework collects all declarations at boot and renders one form per scope.

```ts
// packages/runtime/src/system-settings.ts
export interface SystemSettingSpec<T> {
  scope: string;                          // 'framework:composio'
  key: string;                            // 'apiKey'
  label: string;                          // 'Composio API key'
  description?: string;                   // 'Used as the OAuth broker...'
  schema: z.ZodType<T>;
  sensitive: boolean;                     // → encrypted at rest, masked in UI
  defaultValue?: T;
  /**
   * Optional reachability test. UI shows a "Test" button that calls this
   * before save. Reject the save if it throws.
   */
  verify?: (value: T) => Promise<void>;
}
```

Framework-shipped declarations (initial set):

| scope | key | sensitive | verify |
|---|---|---|---|
| `framework` | `PUBLIC_URL` | no | HEAD against value, expect 2xx |
| `framework:composio` | `apiKey` | yes | `composio.toolkits.list()` |
| `framework:resend` | `apiKey` | yes | `resend.domains.list()` |
| `framework:sentry` | `dsn` | no | validate DSN format only (no network call) |

Per-module settings (added when a module needs one) follow the same shape with `scope: 'module:<slug>'`.

## Read path

```ts
// packages/runtime/src/system-settings.ts
export async function getSystemSetting<T>(
  db: Db,
  spec: SystemSettingSpec<T>,
  secretsKey: Uint8Array,
): Promise<T | null> {
  const row = await db.select().from(system_settings)
    .where(and(eq(scope, spec.scope), eq(key, spec.key))).limit(1);
  if (!row[0]) return spec.defaultValue ?? null;
  const raw = spec.sensitive
    ? decrypt(row[0].value_encrypted!, secretsKey)
    : row[0].value_plain!;
  return spec.schema.parse(JSON.parse(raw));
}
```

No in-process cache. Each call re-reads. Reasoning:

- A connector resolves Composio settings during OAuth flows (rare path, not hot).
- A connector resolves Resend settings during password-reset emails (rare path).
- Public URL is needed per request for OAuth callbacks, but a per-request DB read is a single indexed lookup — measured negligible vs. the rest of the OAuth roundtrip.
- Cache invalidation across app + worker processes is hard. Skipping the cache eliminates the problem entirely.
- We can add caching later (per-process, TTL ≤30s) if we measure a real cost.

## Write path

Admin-only. Reads `req.user.role === 'admin'`; rejects 403 otherwise.

```
POST /api/admin/settings/:scope/:key
{ "value": <unencrypted JSON value>, "verify": true }
```

Server:

1. Look up `SystemSettingSpec`. Reject 404 if unknown scope/key.
2. Parse the body's `value` against `spec.schema`. Reject 400 with field errors.
3. If `verify: true` and `spec.verify` exists, call it. Reject 400 with the verify error message.
4. If `spec.sensitive`: encrypt with `SECRETS_KEY` via libsodium `crypto_secretbox`, store in `value_encrypted`.
   Else: store JSON-stringified plain text in `value_plain`.
5. Upsert `(scope, key)`, set `updated_by = req.user.id`.
6. Audit-log `system_settings.updated`, scope, key, who, when. **Never the new value** — even hashed.
7. Return 204 No Content.

## UI

`/admin/settings` — single page rendering one section per scope. Each setting:

- Sensitive: shows last-updated timestamp + "Rotate" button → modal with masked input → "Test & Save" / "Save without testing"
- Non-sensitive: shows current value + inline edit + "Test & Save" / "Save"

Setup checklist on the dashboard (per [[2026-06-12-install-wizard.md]]) deep-links to specific rows on this page (e.g. `/admin/settings#framework:composio`).

Form uses the same Zod-form renderer as agent/connector settings (`zod-form.tsx` in `packages/core`). No bespoke component per setting.

## Backwards-compat env-var seed

For the C&M staging + prod installs that already shipped with env vars, plus future installs that might pre-load env vars:

On first boot after the upgrade, before serving any request:

```ts
async function seedFromEnvIfEmpty(db, secretsKey) {
  const envMap: Record<string, { scope: string; key: string; spec: SystemSettingSpec }> = {
    PUBLIC_URL:        { scope: 'framework',          key: 'PUBLIC_URL',  spec: publicUrlSpec },
    COMPOSIO_API_KEY:  { scope: 'framework:composio', key: 'apiKey',      spec: composioSpec },
    RESEND_API_KEY:    { scope: 'framework:resend',   key: 'apiKey',      spec: resendSpec },
    SENTRY_DSN:        { scope: 'framework:sentry',   key: 'dsn',         spec: sentrySpec },
  };
  for (const [envVar, target] of Object.entries(envMap)) {
    if (!process.env[envVar]) continue;
    const existing = await getSystemSetting(db, target.spec, secretsKey);
    if (existing !== null) continue;
    await writeSystemSetting(db, target.scope, target.key, process.env[envVar]!, {
      bySource: 'env-seed',
    });
  }
}
```

Idempotent. Once a setting exists in the DB, env vars are ignored on subsequent boots. After the first upgrade, operators can remove the env vars from `fly.toml`.

The migrate script (`dist/src/migrate.js`) calls this after schema migrations, so the seed happens during the release_command, not during request handling.

## SECRETS_KEY rotation runbook

With more sensitive values living in the DB, `SECRETS_KEY` becomes higher-blast-radius. Define a rotation procedure:

```
node dist/src/migrate-secrets-key.js \
  --old-key <base64> \
  --new-key <base64>
```

Steps:
1. Read every row from `system_settings` where `value_encrypted is not null`.
2. Decrypt with `--old-key`.
3. Re-encrypt with `--new-key`.
4. Update in-place in a single transaction.
5. Repeat for `connector_instances.credentials_encrypted` and any other table that uses `SECRETS_KEY`.
6. Operator updates the Fly secret + restarts: `flyctl secrets set SECRETS_KEY=<new>`.

If the process dies mid-transaction, the row is left in the old state. Either re-run the rotation, or the operator manually restores. Single-row transactions keep the failure domain small.

Document in `docs/runbooks/rotate-secrets-key.md` as a separate spec deliverable.

## Audit log

Every write to `system_settings` produces an audit-log row:

```
{
  action: 'system_settings.updated',
  scope: 'framework:composio',
  key: 'apiKey',
  source: 'admin-ui' | 'env-seed' | 'auto-derive',
  actor: { userId, email } | null,  // null for env-seed and auto-derive
}
```

The **value itself never enters the audit log**, encrypted or otherwise. The audit log is for "who changed what when," not for backup.

## Dependencies + sequencing

- **`role` column on `users`.** Settings page is gated on `role = 'admin'`. The install-wizard spec already requires this. Build once, used by both.
- **User management UI** (per [[project_user_mgmt_backlog]]). Adding additional admins is not in this spec — first admin only. Second-and-later admins go through the user-management page, which is a separate piece of work.
- **Encrypted-at-rest primitive.** `packages/core/src/secrets.ts` already wraps libsodium `crypto_secretbox`. Reuse it. No new crypto.

## Out of scope (explicit)

- Per-tenant per-connector OAuth tokens. Those already live in `connector_instances.credentials_encrypted` and are managed from `/admin/connectors`. No overlap.
- Per-user preferences (theme, digest cadence, etc). Those go in a separate `user_preferences` table when needed.
- A history of past values (rotation log, time-series). The audit log captures "updated"; we don't keep prior values. If someone needs the old key after rotating, that's a "go look it up in the upstream service" problem.
- Bulk import/export of settings. Future work.
