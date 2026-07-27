/** Per-million-token pricing for the model in use. */
export interface Pricing {
  /** USD per 1,000,000 input tokens. */
  inputUsdPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  outputUsdPerMTok: number;
}

/** Opus 4.8 pricing — the C&M default. */
export const OPUS_4_8_PRICING: Pricing = {
  inputUsdPerMTok: 5,
  outputUsdPerMTok: 25,
};

/** Rendering / classification / OCR tuning. All fields optional; sane defaults. */
export interface EngineTuning {
  /** Default render DPI (pages downscale below this only when oversized). */
  dpi?: number;
  /** Max output tokens for an OCR/extraction call. */
  maxTokens?: number;
  /** Non-whitespace char count at/above which a page is treated as text-layer. */
  textThreshold?: number;
  /** Concurrent OCR/text calls. */
  concurrency?: number;
  /** Safe longest-side pixel cap (under the provider's hard limit). */
  maxImagePx?: number;
  /** Pixel overlap between tiles so notes spanning a seam survive. */
  tileOverlapPx?: number;
  /** Max tiles per oversized page (bounds cost). */
  maxTilesPerPage?: number;
}

/** Tuning with every field resolved to a concrete default. */
export interface ResolvedTuning {
  dpi: number;
  maxTokens: number;
  textThreshold: number;
  concurrency: number;
  maxImagePx: number;
  tileOverlapPx: number;
  maxTilesPerPage: number;
}

export function resolveTuning(t: EngineTuning = {}): ResolvedTuning {
  return {
    dpi: t.dpi ?? 150,
    maxTokens: t.maxTokens ?? 8000,
    textThreshold: t.textThreshold ?? 100,
    concurrency: t.concurrency ?? 6,
    maxImagePx: t.maxImagePx ?? 7000,
    tileOverlapPx: t.tileOverlapPx ?? 200,
    maxTilesPerPage: t.maxTilesPerPage ?? 6,
  };
}
