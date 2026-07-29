import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { and, desc, eq, gt, gte, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  defineModule,
  type ModuleServerContext,
  type DigestContext,
  type DigestContribution,
  type DashboardContext,
  type DashboardContribution,
} from '@frontrangesystems/business-os-module-sdk';
import { requireUser } from '@frontrangesystems/business-os-core';
import { prospectorBidFeedback, bidWatcherSeen } from './schema.js';

/**
 * @frontrangesystems/business-os-module-prospector
 *
 * Surfaces scored bid opportunities + collects per-user thumbs feedback.
 * Reads bids from `bid_watcher_seen` (owned by the bid-watcher agent).
 * Owns its own feedback table `prospector_bid_feedback`.
 */

const here = dirname(fileURLToPath(import.meta.url));

const SettingsSchema = z.object({
  newSectionSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe(
      'How many bid cards the Home dashboard shows in "New bids worth a look" (the highest-scoring, not-yet-reviewed bids). Default 20.',
    ),
  minDashboardScore: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(60)
    .describe(
      'Recommended-bid cutoff (0–100). A bid must score at or above this to count as "recommended" — it drives the Home dashboard and the All Bids "Recommended only" default. Lower it to surface more bids for review; raise it to see only the strongest fits.',
    ),
  dashboardCardSize: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe(
      'How many recommended bids to preview on the Home dashboard card. Default 10. Tap through to Prospector for the full list.',
    ),
});
type Settings = z.infer<typeof SettingsSchema>;

const FeedbackRequest = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  reason: z.string().max(500).optional(),
});

function buildDb(): ReturnType<typeof drizzle> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('module-prospector: DATABASE_URL not set');
  const client = postgres(url, { max: 4 });
  return drizzle(client);
}

export default defineModule({
  manifest: {
    slug: 'prospector',
    version: '0.0.1',
    displayName: 'Prospector',
    description: 'Surfaces scored bid opportunities. Tracks thumbs feedback for future relevance tuning.',
    settingsSchema: SettingsSchema,
    migrationsDir: resolve(here, '..', '..', 'migrations'),
  },
  registerRoutes: (rawApp, ctx: ModuleServerContext<Settings>) => {
    const app = rawApp as FastifyInstance;
    const db = buildDb();

    /**
     * GET /api/modules/prospector/bids
     *
     * Query params (all optional):
     *   ?status=<bidwatcher status>     filter to a specific status column value
     *   ?filter=worth-bidding            only bids the caller rated +1
     *   ?filter=not-a-fit                only bids the caller rated -1
     *   ?filter=not-reviewed             only bids the caller hasn't rated yet
     *   ?filter=all (default)            no rating filter
     *   ?recommended=1                   only bids scoring ≥ minDashboardScore
     *   ?limit=<n>                       cap rows (default newSectionSize, max 100)
     */
    app.get(
      '/bids',
      { preHandler: requireUser },
      async (req: FastifyRequest) => {
        const userId = req.user!.id;
        const q = req.query as { limit?: string; status?: string; filter?: string; recommended?: string };
        const limit = Number(q.limit ?? ctx.settings.newSectionSize);
        const status = q.status ?? null;
        const filter = q.filter ?? 'all';
        const recommendedOnly = q.recommended === '1' || q.recommended === 'true';
        const minScore = ctx.settings.minDashboardScore;

        const ratingClause =
          filter === 'worth-bidding'
            ? sql`${prospectorBidFeedback.rating} = 1`
            : filter === 'not-a-fit'
              ? sql`${prospectorBidFeedback.rating} = -1`
              : filter === 'not-reviewed'
                ? sql`${prospectorBidFeedback.rating} IS NULL`
                : sql`TRUE`;

        const rows = await db
          .select({
            source: bidWatcherSeen.source,
            externalId: bidWatcherSeen.externalId,
            title: bidWatcherSeen.title,
            url: bidWatcherSeen.url,
            location: bidWatcherSeen.location,
            estimatedValue: bidWatcherSeen.estimatedValue,
            bidsDueAt: bidWatcherSeen.bidsDueAt,
            score: bidWatcherSeen.score,
            scoreReason: bidWatcherSeen.scoreReason,
            gaps: bidWatcherSeen.gaps,
            status: bidWatcherSeen.status,
            firstSeenAt: bidWatcherSeen.firstSeenAt,
            lastSeenAt: bidWatcherSeen.lastSeenAt,
            myRating: prospectorBidFeedback.rating,
          })
          .from(bidWatcherSeen)
          .leftJoin(
            prospectorBidFeedback,
            and(
              eq(prospectorBidFeedback.source, bidWatcherSeen.source),
              eq(prospectorBidFeedback.externalId, bidWatcherSeen.externalId),
              eq(prospectorBidFeedback.userId, userId),
            ),
          )
          .where(and(
            status ? eq(bidWatcherSeen.status, status) : sql`TRUE`,
            ratingClause,
            recommendedOnly ? gte(bidWatcherSeen.score, minScore) : sql`TRUE`,
          ))
          .orderBy(desc(bidWatcherSeen.score), desc(bidWatcherSeen.firstSeenAt))
          .limit(Math.min(limit, 100));

        return {
          minScore,
          bids: rows.map((r) => ({
            ...r,
            estimatedValue: r.estimatedValue !== null ? Number(r.estimatedValue) : null,
          })),
        };
      },
    );

    /**
     * GET /api/modules/prospector/home
     * Dashboard payload — sectioned for direct rendering by /home.
     * Two sections:
     *   - New bids worth a look (status='new', score ≥ minDashboardScore)
     *   - Recently reviewed (cards the caller has thumbed, most recent first)
     */
    app.get(
      '/home',
      { preHandler: requireUser },
      async (req: FastifyRequest) => {
        const userId = req.user!.id;
        const min = ctx.settings.minDashboardScore;
        const size = ctx.settings.newSectionSize;
        const reviewedLimit = 10;

        const newRows = await db
          .select({
            source: bidWatcherSeen.source,
            externalId: bidWatcherSeen.externalId,
            title: bidWatcherSeen.title,
            url: bidWatcherSeen.url,
            location: bidWatcherSeen.location,
            estimatedValue: bidWatcherSeen.estimatedValue,
            bidsDueAt: bidWatcherSeen.bidsDueAt,
            score: bidWatcherSeen.score,
            scoreReason: bidWatcherSeen.scoreReason,
            status: bidWatcherSeen.status,
            firstSeenAt: bidWatcherSeen.firstSeenAt,
            myRating: prospectorBidFeedback.rating,
          })
          .from(bidWatcherSeen)
          .leftJoin(
            prospectorBidFeedback,
            and(
              eq(prospectorBidFeedback.source, bidWatcherSeen.source),
              eq(prospectorBidFeedback.externalId, bidWatcherSeen.externalId),
              eq(prospectorBidFeedback.userId, userId),
            ),
          )
          .where(and(
            eq(bidWatcherSeen.status, 'new'),
            sql`${bidWatcherSeen.score} >= ${min}`,
            sql`${prospectorBidFeedback.rating} IS NULL`,
          ))
          .orderBy(desc(bidWatcherSeen.score), desc(bidWatcherSeen.firstSeenAt))
          .limit(size);

        // "Recently reviewed" — driven from feedback table (most recent first).
        const reviewedRows = await db
          .select({
            source: bidWatcherSeen.source,
            externalId: bidWatcherSeen.externalId,
            title: bidWatcherSeen.title,
            url: bidWatcherSeen.url,
            location: bidWatcherSeen.location,
            estimatedValue: bidWatcherSeen.estimatedValue,
            bidsDueAt: bidWatcherSeen.bidsDueAt,
            score: bidWatcherSeen.score,
            scoreReason: bidWatcherSeen.scoreReason,
            myRating: prospectorBidFeedback.rating,
            reviewedAt: prospectorBidFeedback.updatedAt,
          })
          .from(prospectorBidFeedback)
          .innerJoin(
            bidWatcherSeen,
            and(
              eq(bidWatcherSeen.source, prospectorBidFeedback.source),
              eq(bidWatcherSeen.externalId, prospectorBidFeedback.externalId),
            ),
          )
          .where(eq(prospectorBidFeedback.userId, userId))
          .orderBy(desc(prospectorBidFeedback.updatedAt))
          .limit(reviewedLimit);

        const cardFromRow = (r: typeof newRows[number]): Record<string, unknown> => ({
          id: `${r.source}::${r.externalId}`,
          source: r.source,
          externalId: r.externalId,
          title: r.title ?? 'Untitled',
          subtitle: [
            r.location,
            r.estimatedValue !== null ? `$${Number(r.estimatedValue).toLocaleString()}` : null,
            r.bidsDueAt ? `Due ${new Date(r.bidsDueAt as unknown as string).toLocaleDateString()}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          score: r.score,
          scoreReason: r.scoreReason,
          href: r.url ?? null,
          myRating: r.myRating ?? null,
        });

        return {
          sections: [
            {
              id: 'new-bids',
              title: 'New bids worth a look',
              subtitle: `Score ≥ ${min}, not yet reviewed`,
              cards: newRows.map(cardFromRow),
            },
            {
              id: 'recently-reviewed',
              title: 'Recently reviewed',
              subtitle: 'Your last calls — tap a thumb to change your mind',
              cards: reviewedRows.map((r) => cardFromRow(r as unknown as typeof newRows[number])),
            },
          ],
        };
      },
    );

    /**
     * POST /api/modules/prospector/bids/:source/:externalId/feedback
     * Upsert a thumbs rating for the current user.
     */
    app.post(
      '/bids/:source/:externalId/feedback',
      { preHandler: requireUser },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const userId = req.user!.id;
        const { source, externalId } = req.params as { source: string; externalId: string };
        const parsed = FeedbackRequest.safeParse(req.body);
        if (!parsed.success) {
          reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
          return;
        }

        await db
          .insert(prospectorBidFeedback)
          .values({
            userId,
            source,
            externalId,
            rating: parsed.data.rating,
            reason: parsed.data.reason ?? null,
          })
          .onConflictDoUpdate({
            target: [
              prospectorBidFeedback.userId,
              prospectorBidFeedback.source,
              prospectorBidFeedback.externalId,
            ],
            set: {
              rating: parsed.data.rating,
              reason: parsed.data.reason ?? null,
              updatedAt: new Date(),
            },
          });

        await req.audit('prospector.feedback.set', {
          source,
          externalId,
          rating: parsed.data.rating,
        });
        return { ok: true as const };
      },
    );

    ctx.logger.info(
      { minDashboardScore: ctx.settings.minDashboardScore, newSectionSize: ctx.settings.newSectionSize },
      'module-prospector routes ready',
    );
  },
  digestContribution: async (
    ctx: DigestContext<Settings>,
  ): Promise<DigestContribution | null> => {
    const db = buildDb();
    // Defensive: digest runtime passes whatever's in the settings table
    // (often `{}` if the operator hasn't touched anything yet). Parse
    // through the schema to apply defaults — Zod's parse() handles this.
    const settings = SettingsSchema.parse(ctx.settings ?? {});
    const min = settings.minDashboardScore;
    const userId = ctx.user.id;

    // High-scoring bids seen since this user's last digest that they
    // haven't reviewed yet. Cap at 5 — digest is a teaser, not a dump.
    const rows = await db
      .select({
        source: bidWatcherSeen.source,
        externalId: bidWatcherSeen.externalId,
        title: bidWatcherSeen.title,
        location: bidWatcherSeen.location,
        estimatedValue: bidWatcherSeen.estimatedValue,
        bidsDueAt: bidWatcherSeen.bidsDueAt,
        score: bidWatcherSeen.score,
        myRating: prospectorBidFeedback.rating,
      })
      .from(bidWatcherSeen)
      .leftJoin(
        prospectorBidFeedback,
        and(
          eq(prospectorBidFeedback.source, bidWatcherSeen.source),
          eq(prospectorBidFeedback.externalId, bidWatcherSeen.externalId),
          eq(prospectorBidFeedback.userId, userId),
        ),
      )
      .where(and(
        eq(bidWatcherSeen.status, 'new'),
        gte(bidWatcherSeen.score, min),
        gt(bidWatcherSeen.firstSeenAt, ctx.since),
        isNull(prospectorBidFeedback.rating),
      ))
      .orderBy(desc(bidWatcherSeen.score), desc(bidWatcherSeen.firstSeenAt))
      .limit(5);

    if (rows.length === 0) return null;

    const items = rows.map((r) => {
      const dueAt = r.bidsDueAt ? new Date(r.bidsDueAt as unknown as string) : null;
      const hoursUntilDue = dueAt ? (dueAt.getTime() - Date.now()) / 36e5 : null;
      const subtitle = [
        r.score ? `Score ${r.score}%` : null,
        r.location,
        r.estimatedValue !== null ? `$${Number(r.estimatedValue).toLocaleString()}` : null,
        dueAt ? `Due ${dueAt.toLocaleDateString()}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        title: r.title ?? 'Untitled',
        subtitle,
        href: `/modules/prospector`,
        // Urgent if due in < 48h AND score is at/above the dashboard threshold.
        isUrgent: !!(
          hoursUntilDue !== null &&
          hoursUntilDue < 48 &&
          hoursUntilDue > 0 &&
          (r.score ?? 0) >= min
        ),
      };
    });

    return {
      sectionTitle: 'New bids worth a look',
      summary: `${items.length} new ${items.length === 1 ? 'bid' : 'bids'} since your last digest.`,
      items,
    };
  },
  dashboardContribution: async (
    ctx: DashboardContext<Settings>,
  ): Promise<DashboardContribution | null> => {
    const db = buildDb();
    // Same defensive parse as digest: the settings row is often `{}` before the
    // operator touches anything, so apply schema defaults.
    const settings = SettingsSchema.parse(ctx.settings ?? {});
    const min = settings.minDashboardScore;
    const size = settings.dashboardCardSize;
    const userId = ctx.user.id;

    // Recommended bids this user hasn't reviewed yet: status 'new',
    // score ≥ cutoff, no rating from this user. Highest score first.
    const rows = await db
      .select({
        source: bidWatcherSeen.source,
        externalId: bidWatcherSeen.externalId,
        title: bidWatcherSeen.title,
        url: bidWatcherSeen.url,
        location: bidWatcherSeen.location,
        estimatedValue: bidWatcherSeen.estimatedValue,
        bidsDueAt: bidWatcherSeen.bidsDueAt,
        score: bidWatcherSeen.score,
      })
      .from(bidWatcherSeen)
      .leftJoin(
        prospectorBidFeedback,
        and(
          eq(prospectorBidFeedback.source, bidWatcherSeen.source),
          eq(prospectorBidFeedback.externalId, bidWatcherSeen.externalId),
          eq(prospectorBidFeedback.userId, userId),
        ),
      )
      .where(and(
        eq(bidWatcherSeen.status, 'new'),
        gte(bidWatcherSeen.score, min),
        isNull(prospectorBidFeedback.rating),
      ))
      .orderBy(desc(bidWatcherSeen.score), desc(bidWatcherSeen.firstSeenAt))
      .limit(size);

    const items = rows.map((r) => {
      const dueAt = r.bidsDueAt ? new Date(r.bidsDueAt as unknown as string) : null;
      const subtitle = [
        r.location,
        r.estimatedValue !== null ? `$${Number(r.estimatedValue).toLocaleString()}` : null,
        dueAt ? `Due ${dueAt.toLocaleDateString()}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        title: r.title ?? 'Untitled',
        subtitle: subtitle || undefined,
        // Prefer the source posting; fall back to the module page.
        href: r.url ?? '/modules/prospector',
        badge: r.score !== null ? `Score ${r.score}%` : undefined,
      };
    });

    return {
      title: 'Bids worth a look',
      summary: `Top ${items.length === 1 ? 'recommendation' : `${items.length} recommendations`} the Prospector picked for you.`,
      items,
      emptyText: 'No new recommended bids right now — check back after the next scan.',
      ctaLabel: 'View all bids',
      ctaHref: '/modules/prospector',
    };
  },
});

export { prospectorBidFeedback, bidWatcherSeen } from './schema.js';

// ---------------------------------------------------------------------------
// Service layer — call these from agents/modules instead of querying tables
// directly. The function owns the join, the schema, and the return shape.
// ---------------------------------------------------------------------------

export interface FeedbackExample {
  rating: 1 | -1;
  title: string;
  location: string | null;
  estimatedValue: number | null;
  score: number | null;
  scoreReason: string | null;
}

/**
 * Returns the most recent operator feedback examples (thumbs + bid context)
 * for use as few-shot examples in LLM scoring prompts.
 *
 * Pass `ctx.db` (cast to `ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>`)
 * or call `buildDb()` for a standalone connection.
 */
export async function getFeedbackExamples(
  db: ReturnType<typeof drizzle>,
  limit: number,
): Promise<FeedbackExample[]> {
  if (limit === 0) return [];
  const rows = await db
    .select({
      rating: prospectorBidFeedback.rating,
      title: bidWatcherSeen.title,
      location: bidWatcherSeen.location,
      estimatedValue: bidWatcherSeen.estimatedValue,
      score: bidWatcherSeen.score,
      scoreReason: bidWatcherSeen.scoreReason,
    })
    .from(prospectorBidFeedback)
    .innerJoin(
      bidWatcherSeen,
      and(
        eq(bidWatcherSeen.source, prospectorBidFeedback.source),
        eq(bidWatcherSeen.externalId, prospectorBidFeedback.externalId),
      ),
    )
    .orderBy(desc(prospectorBidFeedback.updatedAt))
    .limit(limit);

  return rows.map((r) => ({
    rating: (r.rating === 1 ? 1 : -1) as 1 | -1,
    title: r.title ?? 'Untitled',
    location: r.location,
    estimatedValue: r.estimatedValue !== null ? Number(r.estimatedValue) : null,
    score: r.score,
    scoreReason: r.scoreReason,
  }));
}
