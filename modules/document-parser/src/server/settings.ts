import { z } from 'zod';
import {
  CONSTRUCTION_BID_TAXONOMY,
  OPUS_4_8_PRICING,
  type ExtractionTaxonomy,
  type Pricing,
} from '@frontrangesystems/business-os-extraction-engine';

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
});

export type Settings = z.infer<typeof SettingsSchema>;

/** Build the engine taxonomy from operator settings. */
export function buildTaxonomy(settings: Settings): ExtractionTaxonomy {
  const pageTypes = settings.extractionPageTypes
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    documentDescription: settings.extractionDomain,
    pageTypes: pageTypes.length > 0 ? pageTypes : CONSTRUCTION_BID_TAXONOMY.pageTypes,
    itemGuidance: settings.extractionItemGuidance,
    captureQuantity: settings.captureQuantity,
    metaGuidance: CONSTRUCTION_BID_TAXONOMY.metaGuidance,
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
