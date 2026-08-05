/**
 * ExtractionTaxonomy — the per-company customization seam.
 *
 * The prompts are NOT hardcoded to one jurisdiction. A consuming module passes
 * a taxonomy describing the document domain, the allowed page-type set, and
 * what pay-items look like; the engine builds its vision/text prompts from it.
 * This is what lets Company A (curb-and-gutter LF + concrete CY) and Company B
 * (asphalt tonnage) share one engine with different behavior — same code,
 * different config.
 */
export interface ExtractionTaxonomy {
  /**
   * Human description of the document domain, dropped into every prompt.
   * e.g. "construction bid document (Louisiana DOTD)".
   */
  documentDescription: string;
  /** Allowed page types the model may assign to a page. */
  pageTypes: string[];
  /**
   * Free-text guidance describing what a pay-item / schedule row looks like and
   * how to fill the description / item_code / unit fields for this domain.
   */
  itemGuidance: string;
  /** Whether to ask the model to extract a numeric quantity per item. */
  captureQuantity: boolean;
  /**
   * Guidance for the optional cover-sheet meta extraction (title + owning
   * agency/jurisdiction). Only used when `extractMeta` is called.
   */
  metaGuidance?: string;
  /**
   * Mode B (narrative documents): the trade scope checklist. When a document
   * has no pay-item schedule, scope is extracted by matching the specs/drawings
   * against this fixed list (e.g. footings, slab-on-grade, reinforcing, embeds,
   * tilt panels, mix design). Empty/absent => Mode B extraction is a no-op.
   */
  scopeChecklist?: string[];
  /** Optional extra guidance appended to the Mode B scope prompt. */
  scopeGuidance?: string;
}

/**
 * Default taxonomy — reproduces C&M bid-indexer's construction-bid behavior.
 * A Document Parser pilot for a different company overrides these fields via
 * settings (company profile, pay-items they care about, jurisdiction terms).
 */
export const CONSTRUCTION_BID_TAXONOMY: ExtractionTaxonomy = {
  documentDescription: 'construction bid document (Louisiana DOTD)',
  pageTypes: [
    'bid_summary',
    'typical_section',
    'spec_sheet',
    'plan_sheet',
    'callouts',
    'misc',
  ],
  itemGuidance:
    'A schedule row typically has a line number, an item code like ' +
    '"714-01-00600", a plain-English description like "Slab Sodding ' +
    '(St. Augustine)", an approximate quantity, and a unit of measure. ' +
    'description = the description text exactly as written; item_code = the ' +
    'code if shown; unit = e.g. SQYD, LNFT, EACH, LUMP SUM.',
  captureQuantity: true,
  metaGuidance:
    'Prefer the actual project name printed on the cover (e.g. ' +
    '"LA 1 Widening — Iberville Parish"). jurisdiction = the owning agency / ' +
    'parish / city if stated (e.g. "Iberville Parish", "Louisiana DOTD").',
};

/** The JSON item-array spec fragment shared by the vision + text prompts. */
function itemArraySpec(t: ExtractionTaxonomy): string {
  const fields = t.captureQuantity
    ? '{description, item_code, unit, quantity}'
    : '{description, item_code, unit}';
  const qty = t.captureQuantity
    ? ' quantity = the numeric quantity for the item if shown (a plain number, no units), else null.'
    : '';
  return (
    `array of ${fields} for any pay-item / bid-summary / schedule-of-items ` +
    `rows on the page (empty array if none). ${t.itemGuidance}${qty}`
  );
}

/** Prompt for full-page vision OCR. */
export function visionPrompt(t: ExtractionTaxonomy): string {
  return `You are processing one page of a ${t.documentDescription}.
Return ONLY a JSON object, no prose, with these keys:
- "page_type": one of ${t.pageTypes.join(', ')}
- "ocr_text": the full text visible on the page, transcribed VERBATIM (exact words, no paraphrasing). For drawings, transcribe all labels/callouts/notes you can read.
- "bid_items": ${itemArraySpec(t)}
- "ocr_confidence": your confidence 0-1 that the transcription is complete and accurate.`;
}

/** Prompt for a single cropped TILE of an oversized page. */
export function tileVisionPrompt(t: ExtractionTaxonomy): string {
  return `You are processing ONE TILE (a cropped region) of a large ${t.documentDescription}.
Return ONLY a JSON object, no prose, with these keys:
- "page_type": one of ${t.pageTypes.join(', ')}
- "ocr_text": the full text visible in THIS TILE, transcribed VERBATIM. Transcribe every label/callout/note you can read, even partial ones at the edges.
- "bid_items": ${itemArraySpec(t)}
- "ocr_confidence": your confidence 0-1.`;
}

/** Prompt for cheap text-only item extraction from a page's text layer. */
export function textPrompt(t: ExtractionTaxonomy): string {
  return `You are processing the extracted TEXT LAYER of one page of a ${t.documentDescription}. The text below was extracted verbatim from the PDF; treat it as ground truth.
Return ONLY a JSON object, no prose, with these keys:
- "page_type": one of ${t.pageTypes.join(', ')}
- "bid_items": ${itemArraySpec(t)}

PAGE TEXT:
`;
}

/**
 * Mode B scope-checklist prompt (one page/section of a narrative document).
 * Asks which checklist items are evidenced on THIS page, with a verbatim
 * snippet, using the checklist as ground truth so scope can't be invented.
 * Page text is appended by the caller (mirrors `textPrompt`).
 */
export function scopePrompt(t: ExtractionTaxonomy): string {
  const checklist = (t.scopeChecklist ?? []).map((c) => `- ${c}`).join('\n');
  const guidance = t.scopeGuidance ? `${t.scopeGuidance}\n` : '';
  return `You are an estimating assistant reading ONE page/section of a ${t.documentDescription} that has NO pay-item schedule — scope must be read from the specs and drawings. Below is the fixed TRADE SCOPE CHECKLIST.
Return ONLY a JSON object {"present": [{"item": <one checklist item, copied verbatim from the list>, "status": "present" or "uncertain", "evidence": <short verbatim snippet from the page text, <=160 chars>}]} listing which checklist items are actually specified/shown on THIS page. Include an item ONLY if the text gives real evidence for it; use "uncertain" when the text hints but is ambiguous. Empty array if none. Do not invent items outside the checklist.
${guidance}
TRADE SCOPE CHECKLIST:
${checklist}

PAGE TEXT:
`;
}

/** Prompt for cover-sheet meta extraction (title + jurisdiction). */
export function metaPrompt(t: ExtractionTaxonomy): string {
  const guidance = t.metaGuidance ?? '';
  return `You are reading the cover/summary text of a ${t.documentDescription}. From the text below, identify:
- "title": a short human-friendly project title. ${guidance} If you genuinely cannot find one, use null. Keep the title under ~80 characters.
- "jurisdiction": the owning agency / parish / city if stated, else null.
Return ONLY a JSON object {"title": ..., "jurisdiction": ...}, no prose.

DOCUMENT TEXT:
`;
}
