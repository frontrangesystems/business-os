/**
 * Document-shape detection (Mode A vs Mode B).
 *
 * A DOT/horizontal bid publishes a schedule of pay-items with populated
 * quantities — you extract the rows. A building/commercial bid has no schedule;
 * scope lives in the specs + drawings and the estimator derives it — you extract
 * against a trade scope checklist. This function decides which a document is,
 * deterministically, from signals the parse already produced (no extra LLM call).
 *
 * The discriminator is the one the field asked for: a genuine schedule has a
 * column of POPULATED numeric quantities. A unit-price / change-order form has
 * item + unit but no quantities, so it must NOT be mistaken for the scope of
 * work — that exact confusion is what made the parser miss the concrete scope on
 * building documents.
 */
import type { DocumentShape, ExtractedItem, ParsedPage, ShapeSignal } from './types.js';

export interface DetectShapeInput {
  /** Deduped items across the document (only `quantity` is read). */
  items: Pick<ExtractedItem, 'quantity'>[];
  /** Per-page results (only `pageType` is read). */
  pages: Pick<ParsedPage, 'pageType'>[];
  /**
   * Whether quantity capture was enabled for this run. When off, quantities are
   * always null, so the quantity signal can't be used and detection falls back
   * to a labelled schedule page with enough rows.
   */
  captureQuantity: boolean;
  /** Populated-quantity item count at/above which the doc is a schedule. */
  minQuantifiedItems?: number;
  /** Row count on a labelled bid_summary page that also implies a schedule. */
  minSummaryItems?: number;
}

const DEFAULT_MIN_QUANTIFIED = 5;
const DEFAULT_MIN_SUMMARY = 5;

/** The bid-summary page type in the default taxonomy. */
const SUMMARY_PAGE_TYPE = 'bid_summary';

export function detectDocumentShape(input: DetectShapeInput): ShapeSignal {
  const minQuantified = input.minQuantifiedItems ?? DEFAULT_MIN_QUANTIFIED;
  const minSummary = input.minSummaryItems ?? DEFAULT_MIN_SUMMARY;

  const totalItems = input.items.length;
  const quantifiedItems = input.items.filter((i) => i.quantity != null).length;
  const hasSummaryPage = input.pages.some((p) => p.pageType === SUMMARY_PAGE_TYPE);

  const verdict = (shape: DocumentShape, reason: string): ShapeSignal => ({
    shape,
    quantifiedItems,
    totalItems,
    hasSummaryPage,
    reason,
  });

  // Primary: a real schedule has a cluster of POPULATED numeric quantities.
  if (input.captureQuantity && quantifiedItems >= minQuantified) {
    return verdict(
      'schedule',
      `${quantifiedItems} items carry populated quantities (>= ${minQuantified})`,
    );
  }

  // Secondary: a page the model explicitly labelled the bid summary, with a real
  // cluster of rows, is a schedule even when quantities are sparse or capture is
  // disabled for this install.
  if (hasSummaryPage && totalItems >= minSummary) {
    return verdict(
      'schedule',
      `labelled ${SUMMARY_PAGE_TYPE} page with ${totalItems} rows (>= ${minSummary})`,
    );
  }

  // Otherwise there is no schedule to anchor to — scope must come from the specs
  // and drawings (Mode B).
  return verdict(
    'narrative',
    input.captureQuantity
      ? `only ${quantifiedItems} quantified rows and no labelled schedule — ` +
          `scope must be derived from specs/drawings`
      : `quantity capture off and no labelled schedule with >= ${minSummary} rows`,
  );
}
