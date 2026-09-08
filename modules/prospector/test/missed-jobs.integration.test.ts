import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { freshDb, newUser, pgReachable, TEST_DATABASE_URL } from './_db.js';
import { prospectorMissedJob } from '../src/server/schema.js';

const reachable = await pgReachable(TEST_DATABASE_URL);
const suite = reachable ? describe : describe.skip;
if (!reachable) {
  // eslint-disable-next-line no-console
  console.warn(`[prospector] skipping integration tests — ${TEST_DATABASE_URL} unreachable`);
}

suite('prospector missed-job reports (real Postgres)', () => {
  let db: Awaited<ReturnType<typeof freshDb>>['db'];
  let sqlClient: Awaited<ReturnType<typeof freshDb>>['sql'];
  let userId: string;

  beforeAll(async () => {
    const h = await freshDb();
    db = h.db;
    sqlClient = h.sql;
    userId = await newUser(sqlClient);
  });

  afterAll(async () => {
    await sqlClient?.end({ timeout: 1 }).catch(() => {});
  });

  it('applies the migration and stores a report with just a url (status defaults to open)', async () => {
    const [row] = await db
      .insert(prospectorMissedJob)
      .values({ userId, url: 'https://centralauctionhouse.com/job/12345' })
      .returning();

    expect(row?.url).toBe('https://centralauctionhouse.com/job/12345');
    expect(row?.status).toBe('open'); // default
    expect(row?.title).toBeNull();
    expect(row?.foundVia).toBeNull();
    expect(row?.note).toBeNull();
  });

  it('stores the optional context fields when provided', async () => {
    const [row] = await db
      .insert(prospectorMissedJob)
      .values({
        userId,
        url: 'https://nola.gov/bid/roadway-overlay',
        title: 'Roadway overlay — District 2',
        foundVia: 'Central Auction',
        note: 'Should have matched — surface paving in our lane.',
      })
      .returning();

    expect(row?.title).toBe('Roadway overlay — District 2');
    expect(row?.foundVia).toBe('Central Auction');
    expect(row?.note).toContain('surface paving');
  });

  it('the open queue excludes resolved reports', async () => {
    const [row] = await db
      .insert(prospectorMissedJob)
      .values({ userId, url: 'https://example.test/to-resolve' })
      .returning();

    // Resolve it (what POST /missed-jobs/:id/resolve does).
    await db
      .update(prospectorMissedJob)
      .set({ status: 'resolved', updatedAt: new Date() })
      .where(eq(prospectorMissedJob.id, row!.id));

    const open = await db
      .select()
      .from(prospectorMissedJob)
      .where(eq(prospectorMissedJob.status, 'open'));

    expect(open.some((j) => j.id === row!.id)).toBe(false);
    expect(open.length).toBeGreaterThan(0); // the earlier two are still open
  });

  it('rejects an invalid status via the CHECK constraint', async () => {
    const [row] = await db
      .insert(prospectorMissedJob)
      .values({ userId, url: 'https://example.test/bad-status' })
      .returning();

    await expect(
      db
        .update(prospectorMissedJob)
        .set({ status: 'archived' })
        .where(eq(prospectorMissedJob.id, row!.id)),
    ).rejects.toThrow();
  });

  it('deleting the user cascades away their missed-job reports', async () => {
    const tmpUser = await newUser(sqlClient, 'temp-estimator@example.test');
    await db
      .insert(prospectorMissedJob)
      .values({ userId: tmpUser, url: 'https://example.test/cascade' });

    await sqlClient`DELETE FROM users WHERE id = ${tmpUser}`;

    const left = await db
      .select()
      .from(prospectorMissedJob)
      .where(and(eq(prospectorMissedJob.userId, tmpUser)));
    expect(left).toHaveLength(0);
  });
});
