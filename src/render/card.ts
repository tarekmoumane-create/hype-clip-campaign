import type { Submission, SubmissionFlag } from '../types.js';
import { FLAG_LABELS, isBlockingFlag } from '../domain/fraud.js';

/**
 * Builds the structured payload the chat client renders as a submission card.
 *
 * The server decides what the card says and which buttons exist — never the
 * client. That matters for the admin controls: if the client decided whether
 * to draw Approve/Decline, a patched client could draw them for anyone. The
 * server still re-checks permission on the action itself, but not shipping the
 * buttons to non-admins keeps the two layers honest.
 */

export interface CardAction {
  /** Stable id the client sends back to POST /submissions/:id/decision. */
  id: 'approve' | 'decline' | 'reopen';
  label: string;
  style: 'primary' | 'danger' | 'neutral';
  /** When true, client should confirm before firing. */
  confirm?: boolean;
}

export interface CardFlag {
  code: SubmissionFlag;
  label: string;
  severity: 'warning' | 'info';
}

export interface SubmissionCard {
  submissionId: string;
  status: Submission['status'];
  platform: Submission['platform'];
  /** Where tapping the card should go. */
  url: string;
  submitterUserId: string;
  /** e.g. "@alice" — resolved by the app from submitterUserId. */
  submitterLabel: string;

  /** Handle that actually posted the video, per the platform. */
  authorHandle: string | null;

  /** Raw number for sorting; null when unavailable. */
  views: number | null;
  /** Pre-formatted for display, e.g. "12.4K" or "—". */
  viewsLabel: string;
  /** Unix ms of the reading behind viewsLabel. */
  viewsAsOf: number | null;

  caption: string | null;
  postedAt: number | null;

  flags: CardFlag[];
  /** Short status line, e.g. "Approved by @tarek". */
  statusLabel: string;
  /** Empty for non-admins and for already-decided submissions. */
  actions: CardAction[];
  /** Plain-text fallback for clients without rich cards. */
  fallbackText: string;
}

export interface BuildCardContext {
  /** Whether the person who will see this card is a campaign admin. */
  viewerIsAdmin: boolean;
  /** Display name for the submitter, resolved by the app. */
  submitterLabel?: string;
  /** Display name for whoever decided, resolved by the app. */
  deciderLabel?: string;
  /** Allows an admin to approve their own submission. */
  allowSelfApproval?: boolean;
  /** The viewer's user id, needed for the self-approval check. */
  viewerUserId?: string;
}

export function buildCard(submission: Submission, ctx: BuildCardContext): SubmissionCard {
  const submitterLabel = ctx.submitterLabel ?? `user:${submission.submitterUserId}`;

  const flags: CardFlag[] = submission.flags.map((code) => ({
    code,
    label: FLAG_LABELS[code],
    severity: isBlockingFlag(code) ? 'warning' : 'info',
  }));

  const isSelf = ctx.viewerUserId === submission.submitterUserId;
  const canAct =
    ctx.viewerIsAdmin && submission.status === 'pending' && (!isSelf || ctx.allowSelfApproval === true);

  const actions: CardAction[] = canAct
    ? [
        { id: 'approve', label: 'Approve', style: 'primary' },
        { id: 'decline', label: 'Decline', style: 'danger', confirm: true },
      ]
    : ctx.viewerIsAdmin && submission.status !== 'pending'
      ? [{ id: 'reopen', label: 'Reopen', style: 'neutral', confirm: true }]
      : [];

  return {
    submissionId: submission.id,
    status: submission.status,
    platform: submission.platform,
    url: submission.canonicalUrl,
    submitterUserId: submission.submitterUserId,
    submitterLabel,
    authorHandle: submission.authorHandle,
    views: submission.latestViews,
    viewsLabel: formatViews(submission.latestViews),
    viewsAsOf: submission.latestViewsAt,
    caption: truncate(submission.caption, 120),
    postedAt: submission.postedAt,
    flags,
    statusLabel: statusLabel(submission, ctx.deciderLabel),
    actions,
    fallbackText: fallbackText(submission, submitterLabel),
  };
}

/** 0 -> "0", 1234 -> "1.2K", 1856732 -> "1.9M", null -> "—". */
export function formatViews(views: number | null): string {
  if (views === null || !Number.isFinite(views)) return '—';
  if (views < 1_000) return String(views);
  if (views < 1_000_000) return `${trimZero(views / 1_000)}K`;
  if (views < 1_000_000_000) return `${trimZero(views / 1_000_000)}M`;
  return `${trimZero(views / 1_000_000_000)}B`;
}

function trimZero(value: number): string {
  const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded;
}

function statusLabel(submission: Submission, deciderLabel?: string): string {
  switch (submission.status) {
    case 'pending':
      return submission.flags.some(isBlockingFlag) ? 'Pending — needs a look' : 'Pending review';
    case 'approved':
      return deciderLabel ? `Approved by ${deciderLabel}` : 'Approved';
    case 'declined':
      return submission.declineReason
        ? `Declined — ${submission.declineReason}`
        : deciderLabel
          ? `Declined by ${deciderLabel}`
          : 'Declined';
  }
}

function fallbackText(submission: Submission, submitterLabel: string): string {
  const platform = submission.platform === 'tiktok' ? 'TikTok' : 'Instagram';
  const views = formatViews(submission.latestViews);
  const lines = [
    `${submitterLabel} submitted a ${platform} clip`,
    submission.canonicalUrl,
    `Views: ${views}`,
    `Status: ${submission.status}`,
  ];
  if (submission.flags.length > 0) {
    lines.push(`Flags: ${submission.flags.map((f) => FLAG_LABELS[f]).join('; ')}`);
  }
  return lines.join('\n');
}

function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
