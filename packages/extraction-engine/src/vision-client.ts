import Anthropic from '@anthropic-ai/sdk';

import type { LlmUsage } from './types.js';
import { sleep } from './util.js';

/** Media types the engine sends (it only renders JPEG today). */
export type LlmImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface LlmImage {
  mediaType: LlmImageMediaType;
  /** Base64-encoded image bytes. */
  dataBase64: string;
}

export interface LlmCompletionRequest {
  model: string;
  maxTokens: number;
  /** The text prompt. */
  text: string;
  /** Optional images to include before the text (vision calls). */
  images?: LlmImage[];
}

export interface LlmCompletion {
  text: string;
  usage: LlmUsage;
}

/**
 * The engine's only dependency on an LLM provider. The default implementation
 * wraps `@anthropic-ai/sdk`; tests inject a fake. Keeping this minimal is what
 * makes the engine provider-agnostic and unit-testable without network access.
 */
export interface VisionLlmClient {
  complete(req: LlmCompletionRequest): Promise<LlmCompletion>;
}

/**
 * Thrown by a client when the provider rejects an image for being too large.
 * The engine catches this to fall back to tiling. Provider-specific error
 * shapes stay inside the client; the engine only sees this typed signal.
 */
export class OversizeImageError extends Error {
  constructor(message = 'image dimensions exceed the provider limit') {
    super(message);
    this.name = 'OversizeImageError';
  }
}

/**
 * Retry transient failures (429 / 529 / 5xx) with exponential backoff + jitter.
 * A single transient 500 across dozens of vision calls is common and must not
 * abort a whole document.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      const status = (err as { status?: number })?.status;
      const transient =
        status === 429 ||
        status === 529 ||
        (typeof status === 'number' && status >= 500);
      if (!transient || attempt >= maxAttempts) throw err;
      const wait =
        Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      await sleep(wait);
    }
  }
}

/** True if an Anthropic 400 is the "image dimensions exceed 8000px" rejection. */
function isOversizeImageError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400) return false;
  const msg = ((err as { message?: string })?.message ?? '').toLowerCase();
  return msg.includes('8000') || msg.includes('dimension') || msg.includes('pixels');
}

export interface AnthropicVisionClientOptions {
  apiKey: string;
  /** Max attempts per call including the first (default 3). */
  maxRetries?: number;
}

/** Default `VisionLlmClient` backed by Anthropic. */
export function createAnthropicVisionClient(
  opts: AnthropicVisionClientOptions,
): VisionLlmClient {
  const anthropic = new Anthropic({ apiKey: opts.apiKey });
  const maxAttempts = opts.maxRetries ?? 3;
  return {
    async complete(req: LlmCompletionRequest): Promise<LlmCompletion> {
      const images = req.images ?? [];
      const content: Anthropic.ContentBlockParam[] = images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 },
      }));
      content.push({ type: 'text', text: req.text });
      try {
        const resp = await withRetry(
          () =>
            anthropic.messages.create({
              model: req.model,
              max_tokens: req.maxTokens,
              // Plain string content when there are no images (cheaper text call).
              messages: [
                {
                  role: 'user',
                  content: images.length > 0 ? content : req.text,
                },
              ],
            }),
          maxAttempts,
        );
        const block = resp.content.find((b) => b.type === 'text');
        const text = block && block.type === 'text' ? block.text : '';
        return {
          text,
          usage: {
            inputTokens: resp.usage.input_tokens,
            outputTokens: resp.usage.output_tokens,
          },
        };
      } catch (err) {
        if (isOversizeImageError(err)) throw new OversizeImageError();
        throw err;
      }
    },
  };
}
