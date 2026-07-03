import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToFieldSchema } from '../src/zod-form.js';

describe('zodToFieldSchema', () => {
  it('handles a plain string with default', () => {
    const out = zodToFieldSchema(z.string().default('hi'));
    expect(out).toEqual({ type: 'string', default: 'hi' });
  });

  it('marks optional fields', () => {
    const out = zodToFieldSchema(z.string().optional());
    expect(out).toEqual({ type: 'string', optional: true });
  });

  it('marks nullable as optional', () => {
    const out = zodToFieldSchema(z.string().nullable());
    expect(out).toEqual({ type: 'string', optional: true });
  });

  it('promotes long strings to multiline', () => {
    const out = zodToFieldSchema(z.string().max(1000));
    expect(out).toEqual({ type: 'string', multiline: true });
  });

  it('passes through number constraints', () => {
    const out = zodToFieldSchema(z.number().int().min(1).max(100).default(10));
    expect(out).toEqual({
      type: 'number',
      int: true,
      min: 1,
      max: 100,
      default: 10,
    });
  });

  it('emits enum values', () => {
    const out = zodToFieldSchema(z.enum(['low', 'medium', 'high']).default('medium'));
    expect(out).toEqual({
      type: 'enum',
      values: ['low', 'medium', 'high'],
      default: 'medium',
    });
  });

  it('walks ZodObject recursively', () => {
    const schema = z.object({
      name: z.string(),
      count: z.number().int().default(5),
      tags: z.array(z.string()).optional(),
      enabled: z.boolean().default(true),
    });
    const out = zodToFieldSchema(schema);
    expect(out).toEqual({
      type: 'object',
      fields: {
        name: { type: 'string' },
        count: { type: 'number', int: true, default: 5 },
        tags: { type: 'stringArray', optional: true },
        enabled: { type: 'boolean', default: true },
      },
    });
  });

  it('falls back to unknown for unsupported types', () => {
    const out = zodToFieldSchema(z.union([z.string(), z.number()]));
    expect(out.type).toBe('unknown');
  });

  it('preserves descriptions', () => {
    const out = zodToFieldSchema(
      z.string().describe('Free-form notes for the operator'),
    );
    expect(out).toEqual({
      type: 'string',
      description: 'Free-form notes for the operator',
    });
  });

  it('handles a real-world agent settings schema (leadgen-ish)', () => {
    const schema = z.object({
      icp: z.string().min(1).describe('ICP description'),
      targetingNotes: z.string().optional(),
      maxPerRun: z.number().int().positive().max(50).default(10),
      llm: z.object({
        providerSlug: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
      }),
    });
    const out = zodToFieldSchema(schema);
    expect(out.type).toBe('object');
    if (out.type !== 'object') throw new Error('expected object');
    expect(out.fields.icp).toMatchObject({ type: 'string', description: 'ICP description' });
    expect(out.fields.targetingNotes).toMatchObject({ type: 'string', optional: true });
    expect(out.fields.maxPerRun).toMatchObject({ type: 'number', int: true, max: 50, default: 10 });
    expect(out.fields.llm).toMatchObject({ type: 'object' });
  });

  it('unwraps ZodEffects (preprocess/refine) and renders the inner schema', () => {
    const inner = z.object({
      reportMissedBid: z.object({ source: z.string().min(1) }).optional(),
    });
    const schema = z.preprocess((raw) => raw ?? {}, inner);
    const out = zodToFieldSchema(schema);
    expect(out.type).toBe('object');
    if (out.type !== 'object') throw new Error('expected object');
    expect(out.fields.reportMissedBid).toMatchObject({ type: 'object', optional: true });
  });
});
