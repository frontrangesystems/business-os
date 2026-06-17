import { describe, it, expect } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../src/routes/_require-user.js';

/**
 * Pure-logic tests for the requireRole preHandler factory. No DB — we hand it a
 * fake req (with req.user already populated, as requireUser would) and a fake
 * reply that records the status/payload.
 */

interface FakeReply {
  statusCode: number | null;
  payload: unknown;
  code(c: number): FakeReply;
  send(p: unknown): FakeReply;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    statusCode: null,
    payload: undefined,
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(p) {
      this.payload = p;
      return this;
    },
  };
  return reply;
}

function makeReq(user: { id: string; email: string; roles: string[] } | null): FastifyRequest {
  return { user } as unknown as FastifyRequest;
}

describe('requireRole', () => {
  it('allows a user holding the required role (no reply sent)', async () => {
    const reply = makeReply();
    const req = makeReq({ id: 'u1', email: 'a@x.com', roles: ['admin'] });
    await requireRole('admin')(req, reply as unknown as FastifyReply);
    // Passing the gate means it never touched reply.
    expect(reply.statusCode).toBeNull();
    expect(reply.payload).toBeUndefined();
  });

  it('allows when the user holds ANY of several allowed roles', async () => {
    const reply = makeReply();
    const req = makeReq({ id: 'u1', email: 'a@x.com', roles: ['estimator'] });
    await requireRole('admin', 'estimator')(req, reply as unknown as FastifyReply);
    expect(reply.statusCode).toBeNull();
  });

  it('denies with 403 when the user holds none of the allowed roles', async () => {
    const reply = makeReply();
    const req = makeReq({ id: 'u1', email: 'a@x.com', roles: ['estimator'] });
    await requireRole('admin')(req, reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(403);
    expect(reply.payload).toEqual({ error: 'forbidden' });
  });

  it('denies with 403 when the user has no roles at all', async () => {
    const reply = makeReply();
    const req = makeReq({ id: 'u1', email: 'a@x.com', roles: [] });
    await requireRole('admin')(req, reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(403);
  });

  it('fails CLOSED with 401 when req.user is absent (misordered preHandlers)', async () => {
    const reply = makeReply();
    const req = makeReq(null);
    await requireRole('admin')(req, reply as unknown as FastifyReply);
    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: 'unauthorized' });
  });
});
