import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  uuid,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * Core schema owned by @frontrangesystems/business-os-db.
 *
 * Each Business OS install is single-tenant. There is no `tenant_id` column
 * anywhere — every row belongs to *this* client. The `client_slug` lives in
 * env + appears in logs/audit for correlation, not in row PKs.
 *
 * Agent-owned tables live in the agent's own package, NOT here.
 */

// -----------------------------------------------------------------------------
// users + sessions + password reset
// -----------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** argon2id hash. Never raw. */
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name'),
    /** Base32 TOTP secret, encrypted at rest. NULL = MFA not enrolled. */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    /** UI theme preference. 'system' follows prefers-color-scheme. */
    theme: text('theme', { enum: ['light', 'dark', 'system'] }).notNull().default('system'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUniq: uniqueIndex('users_email_uniq').on(t.email),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    /** Random 256-bit token, hex. Stored hashed; never raw. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    expiresIdx: index('sessions_expires_idx').on(t.expiresAt),
  }),
);

// -----------------------------------------------------------------------------
// user_roles — many-to-many between users and the app-level role set
// -----------------------------------------------------------------------------

/**
 * Roles a user holds. Many-to-many: a user can hold zero, one, or both of the
 * app-level roles (admin + estimator — see ROLES below).
 *
 * V1 keeps roles as an app-level constant set (ROLES), NOT a separate `roles`
 * table — `role` is just a free-text column validated at the application layer.
 * If roles ever become data-driven (operator-defined roles, descriptions,
 * etc.), a `roles` table + FK can come later without dropping this one.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.role] }),
    userIdx: index('user_roles_user_idx').on(t.userId),
  }),
);

/**
 * App-level role set for V1. These are the only valid values for
 * `user_roles.role`. Not a DB enum (keeps adding a role a code change with no
 * migration) — validated at the application layer.
 */
export const ROLES = {
  ADMIN: 'admin',
  ESTIMATOR: 'estimator',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** All known roles, for validation. */
export const ALL_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.ESTIMATOR];

export function isKnownRole(value: string): value is Role {
  return (ALL_ROLES as readonly string[]).includes(value);
}

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('password_reset_user_idx').on(t.userId),
  }),
);

// -----------------------------------------------------------------------------
// secrets — generic encrypted key/value store
// -----------------------------------------------------------------------------

/**
 * Generic encrypted key/value store. Used by connector credentials, system
 * email keys, and anything else that mustn't sit in plaintext.
 *
 * Value bytes are produced by libsodium crypto_secretbox keyed off SECRETS_KEY.
 */
export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull(), // e.g. "connector:gmail:abc-123" or "system:email"
    key: text('key').notNull(),     // e.g. "access_token", "api_key"
    ciphertext: text('ciphertext').notNull(), // base64
    nonce: text('nonce').notNull(),           // base64
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeKeyUniq: uniqueIndex('secrets_scope_key_uniq').on(t.scope, t.key),
  }),
);

// -----------------------------------------------------------------------------
// settings — per-agent runtime config (non-secret)
// -----------------------------------------------------------------------------

/**
 * Non-secret per-agent / per-connector settings. Operator edits via the
 * auto-rendered settings UI. Schema is owned by the agent/connector manifest.
 */
export const settings = pgTable(
  'settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull(), // e.g. "agent:leadgen" or "connector:gmail:abc-123"
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    scopeUniq: uniqueIndex('settings_scope_uniq').on(t.scope),
  }),
);

// -----------------------------------------------------------------------------
// connector instances — registered providers, keyed by capability
// -----------------------------------------------------------------------------

export const connectorInstances = pgTable(
  'connector_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    capability: text('capability').notNull(), // e.g. "email"
    providerSlug: text('provider_slug').notNull(), // e.g. "gmail"
    displayName: text('display_name').notNull(),
    /** Only one connector per capability is active at a time. */
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    capabilityIdx: index('connector_instances_capability_idx').on(t.capability),
  }),
);

// -----------------------------------------------------------------------------
// audit log — every state-changing operation writes a row here
// -----------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** Free-form action name, e.g. "auth.login", "settings.update" */
    action: text('action').notNull(),
    /** Optional actor — NULL for system actions */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    agentSlug: text('agent_slug'),
    /** request_id for log correlation */
    requestId: text('request_id'),
    /** Free-form metadata; never put secrets here */
    meta: jsonb('meta'),
  },
  (t) => ({
    atIdx: index('audit_log_at_idx').on(t.at),
    actionIdx: index('audit_log_action_idx').on(t.action),
    userIdx: index('audit_log_user_idx').on(t.userId),
  }),
);

// -----------------------------------------------------------------------------
// agent runs — every scheduled or manual run records its outcome
// -----------------------------------------------------------------------------

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentSlug: text('agent_slug').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    ok: boolean('ok'),
    summary: text('summary'),
    details: jsonb('details'),
    /** Why this run fired: cron expression, manual user_id, or event topic */
    trigger: text('trigger').notNull(),
    triggeredBy: uuid('triggered_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    agentIdx: index('agent_runs_agent_idx').on(t.agentSlug),
    startedIdx: index('agent_runs_started_idx').on(t.startedAt),
  }),
);

// -----------------------------------------------------------------------------
// migrations — applied migration tracking, owned by @frontrangesystems/business-os-db
// -----------------------------------------------------------------------------

/**
 * Each owner (framework core, each agent, each connector) writes its own
 * migrations and the runner stamps them here. Forward-only: no rollback rows.
 */
export const migrationsApplied = pgTable(
  'migrations_applied',
  {
    owner: text('owner').notNull(), // e.g. "@frontrangesystems/business-os-db", "@frontrangesystems/business-os-agent-leadgen"
    name: text('name').notNull(),   // e.g. "0001_init"
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
    /** sha256 of the migration sql for drift detection */
    checksum: text('checksum').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.owner, t.name] }),
  }),
);

// Re-export inferred row types for convenience
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;

