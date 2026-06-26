import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import {
  users,
  userRoles,
  ROLES,
  type Db,
} from '@frontrangesystems/business-os-db';
import { requireUser, requireRole } from './_require-user.js';
import { hashPassword } from '../auth/passwords.js';

/**
 * Admin-driven user management.
 *
 * Every route here is gated `[requireUser, requireRole('admin')]` — only an
 * admin can list, create, re-role, rename, or (de)activate users. There is no
 * email-invite flow: an admin sets the new user's initial password directly
 * (email invites need the system-email connector — out of scope for this slice).
 *
 * Last-admin lockout guards: the system must always retain at least one ACTIVE
 * user holding the 'admin' role. We refuse any operation that would drop the
 * count of active admins to zero (removing admin from the last admin, or
 * deactivating the last admin). This is enforced server-side regardless of who
 * the actor is — an admin can't lock everyone (including themselves) out.
 */

const MIN_PASSWORD_LEN = 12;

const PatchUserBody = z
  .object({
    isActive: z.boolean().optional(),
    displayName: z.string().trim().min(1).optional(),
  })
  .refine((b) => b.isActive !== undefined || b.displayName !== undefined, {
    message: 'no_fields',
  });

/**
 * How many ACTIVE users currently hold the 'admin' role, OPTIONALLY excluding a
 * specific user. Used by the lockout guards: "after this change, will there
 * still be an active admin other than the one being demoted/deactivated?"
 */
async function countOtherActiveAdmins(db: Db, excludeUserId: string): Promise<number> {
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(eq(userRoles.role, ROLES.ADMIN), eq(users.isActive, true)));
  const distinct = new Set<string>();
  for (const r of rows) {
    if (r.userId !== excludeUserId) distinct.add(r.userId);
  }
  return distinct.size;
}

async function loadRoles(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.role);
}

export function registerUserRoutes(
  app: FastifyInstance,
  customRoles: Array<{ value: string; label: string }> = [],
): void {
  const adminOnly = { preHandler: [requireUser, requireRole('admin')] };
  const validRoleValues = new Set(['admin', ...customRoles.map((r) => r.value)]);
  const allRoleOptions = [
    { value: 'admin', label: 'Admin' },
    ...customRoles,
  ];

  const RolesArray = z
    .array(z.string())
    .refine((arr) => arr.every((r) => validRoleValues.has(r)), {
      message: 'unknown_role',
    })
    .transform((arr) => Array.from(new Set(arr)));

  const CreateUserBody = z.object({
    email: z.string().email(),
    displayName: z.string().trim().min(1).optional(),
    password: z.string().min(MIN_PASSWORD_LEN),
    roles: RolesArray.optional(),
  });

  const PatchRolesBody = z.object({
    roles: RolesArray,
  });

  // ---------- GET /api/roles ----------
  app.get('/api/roles', adminOnly, async () => {
    return { roles: allRoleOptions };
  });

  // ---------- GET /api/users ----------
  app.get('/api/users', adminOnly, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const userRows = await req.deps.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isActive: users.isActive,
      })
      .from(users)
      .orderBy(users.email);

    const roleRows = await req.deps.db
      .select({ userId: userRoles.userId, role: userRoles.role })
      .from(userRoles);
    const byUser = new Map<string, string[]>();
    for (const r of roleRows) {
      const list = byUser.get(r.userId) ?? [];
      list.push(r.role);
      byUser.set(r.userId, list);
    }

    return {
      users: userRows.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        isActive: u.isActive,
        roles: byUser.get(u.id) ?? [],
      })),
    };
  });

  // ---------- POST /api/users ----------
  app.post('/api/users', adminOnly, async (req, reply) => {
    const parsed = CreateUserBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
    }
    const { email, displayName, password } = parsed.data;
    const roles = parsed.data.roles ?? [];
    const normalizedEmail = email.trim().toLowerCase();

    // Reject duplicate email (the unique index would also catch it, but we want
    // a clean 409 rather than a 500 on the constraint violation).
    const existing = await req.deps.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    if (existing[0]) {
      return reply.code(409).send({ error: 'email_taken' });
    }

    const passwordHash = await hashPassword(password);

    const inserted = await req.deps.db
      .insert(users)
      .values({ email: normalizedEmail, passwordHash, displayName })
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isActive: users.isActive,
      });
    const created = inserted[0];
    if (!created) return reply.code(500).send({ error: 'insert_failed' });

    if (roles.length > 0) {
      await req.deps.db
        .insert(userRoles)
        .values(roles.map((role) => ({ userId: created.id, role })))
        .onConflictDoNothing();
    }

    await req.audit('admin.user.created', { userId: created.id, email: normalizedEmail, roles });

    return reply.code(201).send({
      user: {
        id: created.id,
        email: created.email,
        displayName: created.displayName,
        isActive: created.isActive,
        roles,
      },
    });
  });

  // ---------- PATCH /api/users/:id/roles ----------
  app.patch('/api/users/:id/roles', adminOnly, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = PatchRolesBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
    }
    const nextRoles = parsed.data.roles;

    const target = await req.deps.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!target[0]) return reply.code(404).send({ error: 'user_not_found' });

    // Last-admin guard: if this change removes 'admin' from the target, there
    // must be another ACTIVE admin remaining.
    const currentRoles = await loadRoles(req.deps.db, id);
    const wasAdmin = currentRoles.includes(ROLES.ADMIN);
    const willBeAdmin = nextRoles.includes(ROLES.ADMIN);
    if (wasAdmin && !willBeAdmin) {
      const otherActiveAdmins = await countOtherActiveAdmins(req.deps.db, id);
      if (otherActiveAdmins === 0) {
        return reply.code(409).send({ error: 'last_admin' });
      }
    }

    // Replace the user's roles: delete-all then insert the new set, in a txn.
    await req.deps.db.transaction(async (tx) => {
      await tx.delete(userRoles).where(eq(userRoles.userId, id));
      if (nextRoles.length > 0) {
        await tx
          .insert(userRoles)
          .values(nextRoles.map((role) => ({ userId: id, role })))
          .onConflictDoNothing();
      }
    });

    await req.audit('admin.user.roles.updated', { userId: id, roles: nextRoles });
    return { ok: true as const, roles: nextRoles };
  });

  // ---------- PATCH /api/users/:id ----------
  app.patch('/api/users/:id', adminOnly, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = PatchUserBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues });
    }

    const target = await req.deps.db
      .select({ id: users.id, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!target[0]) return reply.code(404).send({ error: 'user_not_found' });

    // Last-admin guard: deactivating the last active admin is forbidden.
    if (parsed.data.isActive === false) {
      const roles = await loadRoles(req.deps.db, id);
      if (roles.includes(ROLES.ADMIN)) {
        const otherActiveAdmins = await countOtherActiveAdmins(req.deps.db, id);
        if (otherActiveAdmins === 0) {
          return reply.code(409).send({ error: 'last_admin' });
        }
      }
    }

    const patch: { isActive?: boolean; displayName?: string; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (parsed.data.isActive !== undefined) patch.isActive = parsed.data.isActive;
    if (parsed.data.displayName !== undefined) patch.displayName = parsed.data.displayName;

    const updated = await req.deps.db
      .update(users)
      .set(patch)
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isActive: users.isActive,
      });
    if (!updated[0]) return reply.code(404).send({ error: 'user_not_found' });

    await req.audit('admin.user.updated', {
      userId: id,
      fields: Object.keys(parsed.data),
    });

    const roles = await loadRoles(req.deps.db, id);
    return { ok: true as const, user: { ...updated[0], roles } };
  });

}
