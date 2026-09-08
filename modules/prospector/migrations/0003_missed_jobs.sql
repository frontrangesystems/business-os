-- @business-os/module-prospector / 0003_missed_jobs
-- Operators flag a job the Prospector should have surfaced but didn't
-- ("this should have been included"). One row per report. `url` is the job
-- posting (required); title/found_via/note are optional context. `status`
-- lets an operator clear reports they've handled. These reports are raw
-- coverage-gap signal — which boards/agencies the crawler is missing — not
-- scored bids, so they never join bid_watcher_seen.

CREATE TABLE prospector_missed_job (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url         text NOT NULL,
  title       text,
  found_via   text,
  note        text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX prospector_missed_job_status_idx
  ON prospector_missed_job (status, created_at);
