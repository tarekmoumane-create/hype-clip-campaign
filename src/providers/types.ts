import type { ParsedUrl, VideoMetrics } from '../types.js';

/**
 * The one seam between this feature and whoever supplies view counts.
 *
 * We ship a Scrape Creators implementation because it reads public metrics
 * from a plain URL with no OAuth from the submitter. If that ever needs to
 * change — official platform APIs, a different vendor, admin-entered numbers —
 * only this interface has to be re-implemented. Nothing above it knows or
 * cares where the numbers came from.
 */
export interface ViewCountProvider {
  /** Stable identifier recorded on every snapshot for auditing. */
  readonly name: string;

  /** Reads current public metrics for an already-parsed URL. */
  fetchMetrics(parsed: ParsedUrl): Promise<VideoMetrics>;
}

export type ProviderErrorCode =
  /** Post does not exist, or was deleted. */
  | 'NOT_FOUND'
  /** Post exists but is private, age-restricted, or region-locked. */
  | 'PRIVATE_OR_RESTRICTED'
  /** Post is real but carries no view metric (e.g. an image carousel). */
  | 'NO_VIEW_METRIC'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_CREDITS'
  /** Our API key is missing, wrong, or revoked. */
  | 'AUTH'
  | 'TIMEOUT'
  /** Provider answered, but not in a shape we understand. */
  | 'MALFORMED_RESPONSE'
  /** Anything else, including 5xx. */
  | 'UPSTREAM';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  /** True when a later retry has a real chance of succeeding. */
  readonly retryable: boolean;
  /** HTTP status, when the failure came from a response. */
  readonly status?: number;

  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    if (opts.status !== undefined) this.status = opts.status;
  }

  /** Copy safe to show a submitter in chat. */
  userMessage(): string {
    switch (this.code) {
      case 'NOT_FOUND':
        return "We couldn't find that post. Is the link right, and is the post still up?";
      case 'PRIVATE_OR_RESTRICTED':
        return 'That post is private or restricted, so we cannot read its views. Make it public and resubmit.';
      case 'NO_VIEW_METRIC':
        return 'That post has no view count — make sure you are submitting a video, not a photo post.';
      case 'RATE_LIMITED':
      case 'TIMEOUT':
      case 'UPSTREAM':
        return 'We could not read the view count just now. It will retry automatically.';
      case 'INSUFFICIENT_CREDITS':
      case 'AUTH':
      case 'MALFORMED_RESPONSE':
        return 'Something went wrong on our side reading that post. An admin has been notified.';
    }
  }
}
