-- @business-os/db / 0004_user_roles
-- Roles + first-admin bootstrap. Forward-only: never edit; write a follow-up.
--
-- Two app-level roles for V1: 'admin' and 'estimator'. A user can hold one OR
-- more (many-to-many). `role` is free-text validated at the application layer
-- (see ROLES in schema.ts) rather than a DB enum, so adding a role later is a
-- code change with no migration.

CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);
CREATE INDEX user_roles_user_idx ON user_roles (user_id);

-- First-admin bootstrap: grant 'admin' to every user that exists right now.
-- This preserves today's behavior (any user is a full operator) and locks
-- nobody out of an existing install. New users created after this migration
-- start with NO role until an admin assigns one.
INSERT INTO user_roles (user_id, role)
  SELECT id, 'admin' FROM users
  ON CONFLICT DO NOTHING;
