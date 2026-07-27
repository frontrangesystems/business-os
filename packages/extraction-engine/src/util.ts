import type { PayItem } from './types.js';

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export function nonWhitespaceLen(s: string): number {
  return s.replace(/\s/g, '').length;
}

/** Parse a model JSON reply that may be wrapped in a ```json fence. */
export function parseJsonReply(text: string): unknown {
  try {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/** Coerce a model-supplied quantity (number or numeric-ish string) to a number or null. */
export function toQuantity(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // Strip units/commas the model may append ("1,200 SQYD" -> 1200).
    const cleaned = v.replace(/,/g, '').replace(/[^0-9.\-]/g, '');
    // No digit at all (e.g. "lump sum") is not a quantity.
    if (!/[0-9]/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Normalize + validate a raw bid_items array from any source (LLM reply). */
export function sanitizeItems(raw: unknown): PayItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (it): it is { description: string; item_code?: unknown; unit?: unknown; quantity?: unknown } =>
        typeof (it as { description?: unknown })?.description === 'string' &&
        (it as { description: string }).description.trim().length > 0,
    )
    .map((it) => ({
      description: it.description.trim(),
      itemCode: typeof it.item_code === 'string' ? it.item_code : null,
      unit: typeof it.unit === 'string' ? it.unit : null,
      quantity: toQuantity(it.quantity),
    }));
}

/** Run async tasks with bounded concurrency, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
