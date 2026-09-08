import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createDb, runMigrations, coreMigrations } from '@frontrangesystems/business-os-db';

const here = dirname(fileURLToPath(import.meta.url));

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://businessos:businessos@localhost:4732/businessos_dev';

/** The module's own migrations, applied on top of core. */
const moduleMigrations = {
  owner: '@frontrangesystems/business-os-module-prospector',
  dir: resolve(here, '..', 'migrations'),
};

export async function pgReachable(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, idle_timeout: 1, connect_timeout: 2 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/** Clean slate: drop the schema, then migrate core + the module. */
export async function freshDb(): Promise<ReturnType<typeof createDb> & { url: string }> {
  const wipe = postgres(TEST_DATABASE_URL, { max: 1 });
  try {
    await wipe.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await wipe.end({ timeout: 1 });
  }
  const { db, sql } = createDb({ url: TEST_DATABASE_URL });
  await runMigrations(sql, [coreMigrations, moduleMigrations]);
  return { db, sql, url: TEST_DATABASE_URL };
}

/**
 * Insert a user directly — missed-job rows FK to users(id). Returns the id.
 * email + password_hash are the only NOT NULL columns without a default in
 * core's users table (role/is_active/etc. all default), so fill just those.
 */
export async function newUser(
  sql: ReturnType<typeof createDb>['sql'],
  email = 'estimator@example.test',
): Promise<string> {
  const rows = (await sql`
    INSERT INTO users (email, password_hash)
    VALUES (${email}, 'x')
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}
