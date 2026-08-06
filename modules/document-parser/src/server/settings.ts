import { z } from 'zod';
import {
  CONSTRUCTION_BID_TAXONOMY,
  OPUS_4_8_PRICING,
  type ExtractionTaxonomy,
  type Pricing,
} from '@frontrangesystems/business-os-extraction-engine';

/**
 * Default Mode B trade scope checklist (concrete). Used when a narrative
 * document has no schedule to read: the engine matches specs/drawings against
 * this list, so it's ground truth (scope can't be invented). This is the
 * mo-barracks probe list; a company override lives in settings.
 */
export const DEFAULT_SCOPE_CHECKLIST = [
  'footings',
  'grade beams',
  'pile caps',
  'slab on grade',
  'elevated slabs',
  'foundation walls',
  'retaining walls',
  'columns',
  'tilt panels / precast panels',
  'embeds and anchor bolts',
  'lifting inserts',
  'curbs and sidewalks',
  'equipment pads',
  'joint sealants',
  'reinforcing',
  'formwork',
  'finishing and curing',
  'testing and inspection',
  'mix design approval',
  'cold/hot weather concrete',
];

/** The default checklist as the newline-separated text the settings form shows. */
const DEFAULT_SCOPE_CHECKLIST_TEXT = DEFAULT_SCOPE_CHECKLIST.join('\n');

/**
 * Per-install settings, auto-rendered as a form by core. The taxonomy fields
 * are the per-company customization seam: the same engine adapts to each
 * concrete company's pay-items via config, no fork. Long strings (`.max(>200)`)
 * render as textareas.
 */
export const SettingsSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .default('claude-opus-4-8')
    .describe('Claude model used for extraction. Default claude-opus-4-8 (most accurate on messy plan sheets).'),
  documentLimit: z
    .number()
    .int()
    .min(0)
    .max(100000)
    .default(0)
    .describe('Max documents that can be uploaded. 0 = unlimited (default). A pilot install sets this to 20; the cap is enforced at upload.'),
  extractionDomain: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .default(CONSTRUCTION_BID_TAXONOMY.documentDescription)
    .describe('What kind of document this company uploads, e.g. "construction bid document (Louisiana DOTD)" or "asphalt paving estimate". Steers every extraction prompt.'),
  extractionPageTypes: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .default(CONSTRUCTION_BID_TAXONOMY.pageTypes.join(', '))
    .describe('Comma-separated page types the model may assign to a page (e.g. bid_summary, plan_sheet, spec_sheet).'),
  extractionItemGuidance: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .default(CONSTRUCTION_BID_TAXONOMY.itemGuidance)
    .describe("Guidance on what a pay-item/takeoff row looks like for this company and how to fill description / item code / unit. This is where each company's terminology and the pay-items they care about live."),
  captureQuantity: z
    .boolean()
    .default(true)
    .describe('Extract a numeric quantity per item. On for a takeoff product; the operator can override the extracted quantity per item.'),
  scopeChecklist: z
    .string()
    .trim()
    .max(4000)
    .default(DEFAULT_SCOPE_CHECKLIST_TEXT)
    .describe("Mode B trade scope checklist (one item per line). Used for narrative documents with no pay-item schedule (building/commercial sets): the model reports which of these items the specs/drawings evidence, with verbatim citations. The checklist is ground truth — scope can't be invented outside it. Default is a concrete-trade list."),
  scopeGuidance: z
    .string()
    .trim()
    .max(1000)
    .default('')
    .describe('Optional extra guidance appended to the Mode B scope prompt (e.g. how this company words a spec section, what to treat as evidence). Leave blank for the default behavior.'),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** Split a checklist textarea (newline- or comma-separated) into items. */
export function parseChecklist(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build the engine taxonomy from operator settings. */
export function buildTaxonomy(settings: Settings): ExtractionTaxonomy {
  const pageTypes = settings.extractionPageTypes
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const scopeChecklist = parseChecklist(settings.scopeChecklist);
  const scopeGuidance = settings.scopeGuidance.trim();
  return {
    documentDescription: settings.extractionDomain,
    pageTypes: pageTypes.length > 0 ? pageTypes : CONSTRUCTION_BID_TAXONOMY.pageTypes,
    itemGuidance: settings.extractionItemGuidance,
    captureQuantity: settings.captureQuantity,
    metaGuidance: CONSTRUCTION_BID_TAXONOMY.metaGuidance,
    scopeChecklist: scopeChecklist.length > 0 ? scopeChecklist : DEFAULT_SCOPE_CHECKLIST,
    scopeGuidance: scopeGuidance.length > 0 ? scopeGuidance : undefined,
  };
}

/**
 * Per-MTok pricing for the chosen model, for the cost estimate. Known models
 * are priced; anything else falls back to Opus pricing (a safe over-estimate).
 */
const MODEL_PRICING: Record<string, Pricing> = {
  'claude-opus-4-8': OPUS_4_8_PRICING,
};

export function pricingFor(model: string): Pricing {
  return MODEL_PRICING[model] ?? OPUS_4_8_PRICING;
}
