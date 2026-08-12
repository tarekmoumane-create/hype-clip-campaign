/**
 * Shared domain types for the clip-campaign feature.
 *
 * These mirror the SQL in `migrations/001_init.sql`. If you change one,
 * change the other.
 */

export type Platform = 'tiktok' | 'instagram';

/**
 * Review state of a submission. A submission is created `pending` and moves
 * exactly once to `approved` or `declined`. Both are terminal unless an admin
 * explicitly reopens (see `reopen` in domain/submission.ts).
 */
export type SubmissionStatus = 'pending' | 'approved' | 'declined';

/**
 * Machine-detected concerns surfaced to the admin on the review card.
 * Flags never block a decision on their own — they annotate it. The one
 * exception is DUPLICATE, which is rejected at submit time (see
 * docs/09-edge-cases.md).
 */
export type SubmissionFlag =
  /** Video's author handle does not match the submitter's claimed handle. */
  | 'HANDLE_MISMATCH'
  /** Submitter never claimed a handle on this platform, so we cannot verify. */
  | 'NO_CLAIMED_HANDLE'
  /** Video was posted before the campaign started. */
  | 'POSTED_BEFORE_CAMPAIGN'
  /** View count could not be read from the provider. */
  | 'METRICS_UNAVAILABLE'
  /** View count is suspiciously low; may have been submitted too early. */
  | 'LOW_VIEWS';

/** Normalized result of parsing a submitted URL. */
export interface ParsedUrl {
  platform: Platform;
  /**
   * Stable per-platform identifier used for deduplication:
   * TikTok -> numeric aweme/video id, Instagram -> shortcode.
   */
  externalId: string;
  /** Tracking params stripped, host normalized. Safe to store and display. */
  canonicalUrl: string;
  /** Author handle if the URL itself carried one (TikTok only). */
  handleFromUrl?: string;
  /** True when the input was a vm./vt./instagr.am style link we resolved. */
  wasShortLink: boolean;
}

/** Platform-agnostic metrics snapshot returned by a ViewCountProvider. */
export interface VideoMetrics {
  platform: Platform;
  externalId: string;
  /** The metric the campaign is scored on. Plays for both platforms. */
  views: number;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** Author's handle as reported by the platform, lowercased, no leading @. */
  authorHandle: string;
  authorDisplayName: string | null;
  /** Unix seconds. When the video was posted. */
  postedAt: number | null;
  caption: string | null;
  /** Unix ms. When we read these numbers. */
  fetchedAt: number;
  /** Which provider produced this, for auditing. */
  source: string;
}

export interface CreatorHandle {
  userId: string;
  platform: Platform;
  /** Lowercased, no leading @. */
  handle: string;
  claimedAt: number;
}

export interface Submission {
  id: string;
  campaignId: string;
  chatId: string;
  /** Chat message that carried the command, so the app can attach the card. */
  messageId: string | null;
  submitterUserId: string;

  platform: Platform;
  originalUrl: string;
  canonicalUrl: string;
  externalId: string;

  status: SubmissionStatus;
  flags: SubmissionFlag[];

  authorHandle: string | null;
  postedAt: number | null;
  caption: string | null;

  /** Denormalized latest metrics, for cheap list rendering. */
  latestViews: number | null;
  latestViewsAt: number | null;
  /** Views at the moment of approval, frozen for payout math. */
  viewsAtApproval: number | null;

  /** Set when the provider call failed; null on success. */
  fetchError: string | null;

  decidedByUserId: string | null;
  decidedAt: number | null;
  declineReason: string | null;

  createdAt: number;
  updatedAt: number;
}

export interface ViewSnapshot {
  id: string;
  submissionId: string;
  views: number;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  capturedAt: number;
  source: string;
}

export interface Campaign {
  id: string;
  chatId: string;
  name: string;
  /** Unix seconds. Videos posted before this are flagged. */
  startsAt: number;
  /** Unix seconds, or null for open-ended. Submissions after this are rejected. */
  endsAt: number | null;
  /** Below this, submissions get a LOW_VIEWS flag. 0 disables the check. */
  minViews: number;
  active: boolean;
}
