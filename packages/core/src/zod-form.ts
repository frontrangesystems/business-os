import { z } from 'zod';

/**
 * Zod → FieldSchema converter.
 *
 * The framework's settings UI needs a stable, transport-friendly description
 * of an agent's settings schema. Shipping the actual Zod object over JSON
 * would lose all the introspection (instanceof checks fail across processes).
 *
 * Strategy: walk the Zod tree we ship and emit a discriminated union
 * describing each field. Anything we don't know how to render falls back
 * to type: 'unknown', and the operator UI can fall back to a JSON editor
 * for that field.
 *
 * Supported nodes (the common cases for connector + agent settings):
 *   ZodObject, ZodString, ZodNumber, ZodBoolean, ZodEnum,
 *   ZodOptional, ZodNullable, ZodDefault, ZodArray (of strings).
 */

export type FieldSchema =
  | StringField
  | NumberField
  | BooleanField
  | EnumField
  | ObjectField
  | StringArrayField
  | UnknownField;

export interface StringField {
  type: 'string';
  optional?: boolean;
  default?: string;
  description?: string;
  /** Render as a textarea instead of a single-line input. */
  multiline?: boolean;
  /** Hint that the value should be masked (e.g. systemPrefix is fine; api keys belong in credentials). */
  secret?: boolean;
}
export interface NumberField {
  type: 'number';
  optional?: boolean;
  default?: number;
  description?: string;
  int?: boolean;
  min?: number;
  max?: number;
}
export interface BooleanField {
  type: 'boolean';
  optional?: boolean;
  default?: boolean;
  description?: string;
}
export interface EnumField {
  type: 'enum';
  values: string[];
  optional?: boolean;
  default?: string;
  description?: string;
}
export interface ObjectField {
  type: 'object';
  fields: Record<string, FieldSchema>;
  optional?: boolean;
  description?: string;
}
export interface StringArrayField {
  type: 'stringArray';
  optional?: boolean;
  default?: string[];
  description?: string;
}
export interface UnknownField {
  type: 'unknown';
  reason: string;
}

/**
 * Convert a Zod node into a FieldSchema. Strips ZodOptional / ZodNullable /
 * ZodDefault wrappers and threads their effects into the resulting field.
 */
export function zodToFieldSchema(schema: z.ZodTypeAny): FieldSchema {
  // Unwrap optional / nullable / default — track each effect.
  let s: z.ZodTypeAny = schema;
  let optional = false;
  let defaultValue: unknown = undefined;
  // Walk the modifier stack at most a handful of times.
  for (let i = 0; i < 5; i++) {
    if (s instanceof z.ZodOptional) {
      optional = true;
      s = s._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (s instanceof z.ZodNullable) {
      optional = true;
      s = s._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (s instanceof z.ZodDefault) {
      defaultValue = (s._def.defaultValue as () => unknown)();
      s = s._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (s instanceof z.ZodEffects) {
      // preprocess/refine/transform wrapper — render the inner schema.
      // Validation still runs through the full effects chain server-side.
      s = s._def.schema as z.ZodTypeAny;
      continue;
    }
    break;
  }
  const description = s.description ?? schema.description;

  if (s instanceof z.ZodString) {
    const checks = s._def.checks ?? [];
    const max = checks.find((c: { kind: string }) => c.kind === 'max') as { value: number } | undefined;
    const multiline = !!max && max.value > 200;
    // Convention: a description starting with `secret:` marks the field as
    // masked. Strip the prefix so the visible label stays clean.
    const isSecret = !!description && /^secret:\s*/i.test(description);
    const visibleDescription = isSecret ? description!.replace(/^secret:\s*/i, '').trim() : description;
    return {
      type: 'string',
      ...(optional ? { optional: true } : {}),
      ...(defaultValue !== undefined ? { default: String(defaultValue) } : {}),
      ...(visibleDescription ? { description: visibleDescription } : {}),
      ...(multiline ? { multiline: true } : {}),
      ...(isSecret ? { secret: true } : {}),
    };
  }

  if (s instanceof z.ZodNumber) {
    const checks = s._def.checks ?? [];
    const int = checks.some((c: { kind: string }) => c.kind === 'int');
    const min = checks.find((c: { kind: string }) => c.kind === 'min') as { value: number } | undefined;
    const max = checks.find((c: { kind: string }) => c.kind === 'max') as { value: number } | undefined;
    return {
      type: 'number',
      ...(optional ? { optional: true } : {}),
      ...(defaultValue !== undefined ? { default: Number(defaultValue) } : {}),
      ...(description ? { description } : {}),
      ...(int ? { int: true } : {}),
      ...(min !== undefined ? { min: min.value } : {}),
      ...(max !== undefined ? { max: max.value } : {}),
    };
  }

  if (s instanceof z.ZodBoolean) {
    return {
      type: 'boolean',
      ...(optional ? { optional: true } : {}),
      ...(defaultValue !== undefined ? { default: Boolean(defaultValue) } : {}),
      ...(description ? { description } : {}),
    };
  }

  if (s instanceof z.ZodEnum) {
    const values = s._def.values as readonly string[];
    return {
      type: 'enum',
      values: [...values],
      ...(optional ? { optional: true } : {}),
      ...(defaultValue !== undefined ? { default: String(defaultValue) } : {}),
      ...(description ? { description } : {}),
    };
  }

  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    const fields: Record<string, FieldSchema> = {};
    for (const key of Object.keys(shape)) {
      fields[key] = zodToFieldSchema(shape[key]!);
    }
    return {
      type: 'object',
      fields,
      ...(optional ? { optional: true } : {}),
      ...(description ? { description } : {}),
    };
  }

  if (s instanceof z.ZodArray) {
    const element = s._def.type as z.ZodTypeAny;
    if (element instanceof z.ZodString) {
      return {
        type: 'stringArray',
        ...(optional ? { optional: true } : {}),
        ...(Array.isArray(defaultValue) ? { default: defaultValue as string[] } : {}),
        ...(description ? { description } : {}),
      };
    }
  }

  return { type: 'unknown', reason: `unsupported Zod node: ${s.constructor.name}` };
}
