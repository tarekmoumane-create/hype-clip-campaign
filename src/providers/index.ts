import { config } from '../config.js';
import type { ParsedUrl, VideoMetrics } from '../types.js';
import { MockProvider } from './mock.js';
import { ScrapeCreatorsProvider } from './scrapecreators.js';
import { ProviderError, type ViewCountProvider } from './types.js';

export { ProviderError, MockProvider, ScrapeCreatorsProvider };
export type { ViewCountProvider };
export type { ProviderErrorCode } from './types.js';

/**
 * Wraps a provider with bounded exponential backoff on retryable failures
 * (timeouts, 429s, 5xx). Permanent failures — a deleted post, a private
 * account — are rethrown immediately so we don't waste credits or delay the
 * submitter's feedback.
 */
export class RetryingProvider implements ViewCountProvider {
  readonly name: string;

  constructor(
    private readonly inner: ViewCountProvider,
    private readonly opts: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.name = inner.name;
  }

  async fetchMetrics(parsed: ParsedUrl): Promise<VideoMetrics> {
    const attempts = this.opts.attempts ?? 3;
    const baseDelay = this.opts.baseDelayMs ?? 500;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.inner.fetchMetrics(parsed);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ProviderError && error.retryable;
        if (!retryable || attempt === attempts) throw error;
        await sleep(baseDelay * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }
}

let cached: ViewCountProvider | null = null;

/** Builds the provider named by VIEW_PROVIDER. */
export function getProvider(): ViewCountProvider {
  if (cached) return cached;

  if (config.viewProvider === 'mock') {
    cached = new MockProvider();
    return cached;
  }

  cached = new RetryingProvider(
    new ScrapeCreatorsProvider({
      apiKey: config.scrapeCreators.apiKey,
      baseUrl: config.scrapeCreators.baseUrl,
      timeoutMs: config.scrapeCreators.timeoutMs,
      igCacheMaxAge: config.scrapeCreators.igCacheMaxAge,
      onCredits: (remaining) => {
        if (remaining !== null && remaining < 100) {
          console.warn(`[scrapecreators] credits running low: ${remaining} remaining`);
        }
      },
    }),
  );
  return cached;
}

/** Test seam. */
export function setProvider(provider: ViewCountProvider | null): void {
  cached = provider;
}
