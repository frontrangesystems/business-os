import { pgTable, text, smallint, timestamp, uuid, numeric, integer, jsonb, unique, index } from 'drizzle-orm/pg-core';

/**
 * Module-owned. Per-user thumbs feedback on bids surfaced by the
 * bid-watcher agent.
 */
export const prospectorBidFeedback = pgTable(
  'prospector_bid_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    rating: smallint('rating').notNull(),
    // `reason` = the picked reason tag (from the operator's configurable menu);
    // `note` = optional free-text the tags don't cover. Both feed the scorer.
    reason: text('reason'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    perUserBid: unique('prospector_bid_feedback_user_bid_unique').on(
      t.userId,
      t.source,
      t.externalId,
    ),
    bidIdx: index('prospector_bid_feedback_bid_idx').on(t.source, t.externalId),
  }),
);

/**
 * READ-ONLY view of the bid-watcher agent's table. The module reads bids
 * from here and exposes them as cards on /home. The agent owns writes
 * (see clients/c-and-m-construction-os/agents/bid-watcher/migrations/).
 * Per the architecture decision in [B] of the 2026-06-11 Telegram thread,
 * we accept this cross-primitive read for v1 and may migrate to a
 * module-owned bids table later.
 */
export const bidWatcherSeen = pgTable('bid_watcher_seen', {
  source: text('source').notNull(),
  externalId: text('external_id').notNull(),
  title: text('title'),
  url: text('url'),
  location: text('location'),
  estimatedValue: numeric('estimated_value'),
  bidsDueAt: timestamp('bids_due_at', { withTimezone: true }),
  ownerType: text('owner_type'),
  projectType: text('project_type'),
  payloadHash: text('payload_hash').notNull(),
  score: integer('score'),
  scoreReason: text('score_reason'),
  gaps: jsonb('gaps'),
  status: text('status').notNull(),
  statusSetAt: timestamp('status_set_at', { withTimezone: true }),
  statusSetBy: uuid('status_set_by'),
  notes: text('notes'),
  reportNotes: text('report_notes'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});
