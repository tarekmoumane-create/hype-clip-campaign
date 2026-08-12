import type { ParsedUrl, VideoMetrics } from '../types.js';
import { ProviderError, type ProviderErrorCode, type ViewCountProvider } from './types.js';

/**
 * Deterministic offline provider for tests and local development.
 *
 * View counts are derived from the external id, so the same URL always yields
 * the same number and assertions stay stable. Set VIEW_PROVIDER=mock to run
 * the whole server without spending API credits.
 */
export class MockProvider implements ViewCountProvider {
  readonly name = 'mock';

  private readonly overrides = new Map<string, Partial<VideoMetrics>>();
  private readonly failures = new Map<string, ProviderErrorCode>();

  /** Force specific values for one external id. */
  setMetrics(externalId: string, metrics: Partial<VideoMetrics>): this {
    this.overrides.set(externalId, metrics);
    return this;
  }

  /** Make one external id fail, to exercise error paths. */
  setFailure(externalId: string, code: ProviderErrorCode): this {
    this.failures.set(externalId, code);
    return this;
  }

  async fetchMetrics(parsed: ParsedUrl): Promise<VideoMetrics> {
    const failure = this.failures.get(parsed.externalId);
    if (failure) {
      throw new ProviderError(failure, `Mock failure (${failure}) for ${parsed.externalId}`);
    }

    const seed = hash(parsed.externalId);
    const base: VideoMetrics = {
      platform: parsed.platform,
      externalId: parsed.externalId,
      views: seed % 500_000,
      likes: (seed % 500_000) / 20,
      comments: (seed % 500_000) / 400,
      shares: parsed.platform === 'tiktok' ? (seed % 500_000) / 200 : null,
      authorHandle: parsed.handleFromUrl ?? `creator_${seed % 100}`,
      authorDisplayName: `Creator ${seed % 100}`,
      postedAt: Math.floor(Date.now() / 1000) - (seed % 86_400),
      caption: `Mock caption for ${parsed.externalId}`,
      fetchedAt: Date.now(),
      source: this.name,
    };

    const override = this.overrides.get(parsed.externalId);
    const merged = override ? { ...base, ...override } : base;

    return {
      ...merged,
      likes: merged.likes === null ? null : Math.floor(merged.likes),
      comments: merged.comments === null ? null : Math.floor(merged.comments),
      shares: merged.shares === null ? null : Math.floor(merged.shares),
    };
  }
}

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
