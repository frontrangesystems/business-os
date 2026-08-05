/**
 * Mode B — scope-checklist extraction for narrative documents.
 *
 * When a document has no pay-item schedule (see `detectDocumentShape`), scope
 * can't be read off a table — it lives in the specs and drawings. This runs a
 * cheap text-only pass over the page text the parse already produced (no
 * re-OCR), asking per page which items of a fixed trade scope checklist are
 * evidenced, and aggregates the findings across the document with verbatim
 * citations. The checklist is ground truth: returned items that aren't on it
 * are dropped, so scope can't be invented.
 */
import type { EngineTuning, Pricing } from './config.js';
import { resolveTuning } from './config.js';
import type { Logger } from './types.js';
import type { ExtractionTaxonomy } from './taxonomy.js';
import { scopePrompt } from './taxonomy.js';
import type { VisionLlmClient } from './vision-client.js';
import { mapWithConcurrency, parseJsonReply } from './util.js';

/** One page's verbatim support for a scope item. */
export interface ScopeCitation {
  page: number;
  snippet: string;
}

export type ScopeStatus = 'present' | 'uncertain';

/** A checklist item found in the document, with where the evidence is. */
export interface ScopeFinding {
  /** Canonical checklist item (exactly as written in the taxonomy checklist). */
  item: string;
  /** `present` if any page gave clear evidence; else `uncertain`. */
  status: ScopeStatus;
  /** Verbatim supporting snippets, best/first pages first (capped). */
  citations: ScopeCitation[];
}

export interface ScopeResult {
  /** Findings for checklist items with at least one citation. */
  findings: ScopeFinding[];
  /** The checklist that was applied (for provenance in the UI). */
  checklist: string[];
  /** Distinct checklist items marked `present`. */
  coveredCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ExtractScopeInput {
  vision: VisionLlmClient;
  model: string;
  pricing: Pricing;
  taxonomy: ExtractionTaxonomy;
  /** Page text keyed by 1-based page number (from `ParseResult.pageTexts`). */
  pageTexts: Map<number, string>;
  tuning?: EngineTuning;
  logger: Logger;
  /** Cap on per-page text sent to the model (keeps each call cheap). */
  maxCharsPerPage?: number;
  logId?: string;
}

/** Max scope citations kept per checklist item. */
const MAX_CITATIONS_PER_ITEM = 5;
/** Output-token cap for a scope call (replies are small JSON). */
const SCOPE_MAX_TOKENS = 1500;
/** Default per-page text cap. */
const DEFAULT_MAX_CHARS = 24_000;

interface RawPresent {
  item?: unknown;
  status?: unknown;
  evidence?: unknown;
}

/** Normalize for checklist matching: lower-case, collapse whitespace. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Map a model-returned item name back to a canonical checklist entry. Exact
 * (normalized) match first, then a loose containment either direction so
 * "slab on grade" matches "slab-on-grade slab". Returns null if it matches
 * nothing on the checklist (dropped — scope can't be invented).
 */
export function canonicalizeItem(raw: string, checklist: string[]): string | null {
  const r = norm(raw);
  if (!r) return null;
  const exact = checklist.find((c) => norm(c) === r);
  if (exact) return exact;
  const loose = checklist.find((c) => {
    const n = norm(c);
    return n.includes(r) || r.includes(n);
  });
  return loose ?? null;
}

export async function extractScope(input: ExtractScopeInput): Promise<ScopeResult> {
  const { vision, model, pricing, taxonomy, pageTexts, logger } = input;
  const tuning = resolveTuning(input.tuning);
  const logId = input.logId ?? 'scope';
  const maxChars = input.maxCharsPerPage ?? DEFAULT_MAX_CHARS;
  const checklist = taxonomy.scopeChecklist ?? [];

  if (checklist.length === 0) {
    logger.warn({ logId }, 'extraction.scope.no_checklist');
    return {
      findings: [],
      checklist,
      coveredCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }

  const prompt = scopePrompt(taxonomy);
  const pages = [...pageTexts.entries()]
    .filter(([, txt]) => txt && txt.trim().length > 0)
    .sort((a, b) => a[0] - b[0]);

  let inputTokens = 0;
  let outputTokens = 0;

  const perPage = await mapWithConcurrency(pages, tuning.concurrency, async ([page, text]) => {
    try {
      const { text: reply, usage } = await vision.complete({
        model,
        maxTokens: SCOPE_MAX_TOKENS,
        text: `${prompt}${text.slice(0, maxChars)}`,
      });
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      const parsed = parseJsonReply(reply) as { present?: unknown } | null;
      const present = Array.isArray(parsed?.present) ? (parsed!.present as RawPresent[]) : [];
      return { page, present };
    } catch (err) {
      logger.warn(
        { logId, page, err: err instanceof Error ? err.message : String(err) },
        'extraction.scope.page_failed',
      );
      return { page, present: [] as RawPresent[] };
    }
  });

  // Aggregate across pages, keyed by canonical checklist item.
  const byItem = new Map<string, ScopeFinding>();
  for (const { page, present } of perPage) {
    for (const p of present) {
      if (typeof p?.item !== 'string') continue;
      const canonical = canonicalizeItem(p.item, checklist);
      if (!canonical) continue; // not on the checklist — drop (no invented scope)
      const status: ScopeStatus = p.status === 'uncertain' ? 'uncertain' : 'present';
      const snippet =
        typeof p.evidence === 'string' ? p.evidence.replace(/\s+/g, ' ').trim().slice(0, 200) : '';

      const existing = byItem.get(canonical);
      if (!existing) {
        byItem.set(canonical, {
          item: canonical,
          status,
          citations: snippet ? [{ page, snippet }] : [],
        });
      } else {
        // present wins over uncertain; accumulate citations (capped).
        if (status === 'present') existing.status = 'present';
        if (snippet && existing.citations.length < MAX_CITATIONS_PER_ITEM) {
          existing.citations.push({ page, snippet });
        }
      }
    }
  }

  // Order findings by the checklist's own order for a stable, human-sensible UI.
  const findings = checklist
    .map((c) => byItem.get(c))
    .filter((f): f is ScopeFinding => f !== undefined);

  const coveredCount = findings.filter((f) => f.status === 'present').length;
  const costUsd = Number(
    (
      (inputTokens / 1_000_000) * pricing.inputUsdPerMTok +
      (outputTokens / 1_000_000) * pricing.outputUsdPerMTok
    ).toFixed(4),
  );

  logger.info(
    { logId, covered: coveredCount, found: findings.length, costUsd },
    'extraction.scope.done',
  );

  return { findings, checklist, coveredCount, inputTokens, outputTokens, costUsd };
}
