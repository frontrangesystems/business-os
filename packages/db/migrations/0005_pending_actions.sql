-- @business-os/db / 0005_pending_actions
--
-- The decision layer (see docs/specs/2026-06-24-decision-layer.md).
--
-- One row per action an agent PROPOSES. Depending on the agent's autonomy
-- level the framework either executes the action immediately (recording an
-- 'executed' row for the audit trail) or parks it here as 'pending' for a
-- human to approve/reject in the operator's Approvals inbox. Approval enqueues
-- the agent's declared action handler, which stamps 'executed'/'failed'.
--
-- owner_user_id is null for org/shared scope and set once per-user connector
-- scoping (#3) lands — a personal-inbox action belongs to that user's inbox.

CREATE TABLE pending_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_slug    text NOT NULL,
  -- The run that proposed it (correlation to agent_runs / logs). Nullable so a
  -- run row being pruned never orphans the decision record.
  run_id        uuid,
  action_kind   text NOT NULL,             -- matches a key in manifest.actions
  payload       jsonb NOT NULL DEFAULT '{}',
  summary       text NOT NULL,             -- human-readable, shown in the inbox
  risk          text NOT NULL DEFAULT 'medium'
                  CHECK (risk IN ('low', 'medium', 'high')),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed')),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  executed_at   timestamptz,
  result        jsonb,                     -- handler result, or error detail on 'failed'
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The inbox query is "pending actions (optionally for one agent), newest first".
CREATE INDEX pending_actions_status_agent_idx ON pending_actions (status, agent_slug);
CREATE INDEX pending_actions_created_idx ON pending_actions (created_at DESC);
