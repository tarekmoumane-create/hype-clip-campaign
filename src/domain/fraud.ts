import type { Campaign, SubmissionFlag, VideoMetrics } from '../types.js';
import { normalizeHandle } from '../parse/url.js';

/**
 * Ownership and eligibility checks.
 *
 * Design decision (see docs/07-anti-fraud.md): flags annotate, they do not
 * auto-reject. A machine cannot tell a genuine second account from a stolen
 * clip, and silently rejecting real entries is worse for a campaign than
 * showing an admin a warning. The admin stays the decision-maker; our job is
 * to make sure they are never deciding blind.
 */

export interface FraudCheckInput {
  metrics: VideoMetrics | null;
  /** The submitter's claimed handle for this platform, if they set one. */
  claimedHandle: string | null;
  campaign: Pick<Campaign, 'startsAt' | 'minViews'>;
  /** Unix ms. Injected so tests are deterministic. */
  now?: number;
}

export function evaluateFlags(input: FraudCheckInput): SubmissionFlag[] {
  const flags: SubmissionFlag[] = [];
  const { metrics, claimedHandle, campaign } = input;

  if (!metrics) {
    flags.push('METRICS_UNAVAILABLE');
    // Without metrics we know nothing about the author either.
    if (!claimedHandle) flags.push('NO_CLAIMED_HANDLE');
    return flags;
  }

  if (!claimedHandle) {
    flags.push('NO_CLAIMED_HANDLE');
  } else if (!handlesMatch(claimedHandle, metrics.authorHandle)) {
    flags.push('HANDLE_MISMATCH');
  }

  if (metrics.postedAt !== null && metrics.postedAt < campaign.startsAt) {
    flags.push('POSTED_BEFORE_CAMPAIGN');
  }

  if (campaign.minViews > 0 && metrics.views < campaign.minViews) {
    flags.push('LOW_VIEWS');
  }

  return flags;
}

/**
 * Compares a claimed handle against the handle the platform reports.
 *
 * Exact match after normalization. We deliberately do NOT fuzzy-match:
 * `@nike` and `@nike_official` are different accounts, and treating them as
 * the same is exactly the hole someone would walk through.
 */
export function handlesMatch(claimed: string, actual: string): boolean {
  const a = normalizeHandle(claimed);
  const b = normalizeHandle(actual);
  return a.length > 0 && a === b;
}

/** True when a flag should visually warn the admin rather than just inform. */
export function isBlockingFlag(flag: SubmissionFlag): boolean {
  return flag === 'HANDLE_MISMATCH' || flag === 'POSTED_BEFORE_CAMPAIGN';
}

/** Short, human-readable copy for each flag, for the admin card. */
export const FLAG_LABELS: Record<SubmissionFlag, string> = {
  HANDLE_MISMATCH: 'Posted by a different account than this user claimed',
  NO_CLAIMED_HANDLE: 'User has not linked a handle on this platform',
  POSTED_BEFORE_CAMPAIGN: 'Video was posted before the campaign started',
  METRICS_UNAVAILABLE: 'View count could not be read',
  LOW_VIEWS: 'Below the campaign view minimum',
};
