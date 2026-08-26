-- @business-os/module-prospector / 0002_feedback_note
-- Adds an optional free-text `note` alongside the picked reason tag on
-- feedback, so operators can capture anything the reason menu doesn't cover.
-- `reason` holds the tag; `note` holds the free text. Both feed the scorer.

ALTER TABLE prospector_bid_feedback
  ADD COLUMN IF NOT EXISTS note text;
