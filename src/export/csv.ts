import type { Submission } from '../types.js';

/**
 * Renders approved submissions as CSV — the "log it somewhere" output.
 *
 * Two view columns on purpose:
 *   views_at_approval  what the clip had when the admin approved it
 *   current_views      what it has now
 *
 * Pay against the first and the number is fixed and auditable. Pay against the
 * second and it keeps moving. Whichever you choose, having both means you can
 * always show your work.
 */

const COLUMNS = [
  'submission_id',
  'submitter_user_id',
  'platform',
  'author_handle',
  'url',
  'posted_at',
  'submitted_at',
  'approved_at',
  'approved_by',
  'views_at_approval',
  'current_views',
  'current_views_as_of',
  'flags',
] as const;

export function toCsv(submissions: Submission[]): string {
  const rows = submissions.map((submission) => [
    submission.id,
    submission.submitterUserId,
    submission.platform,
    submission.authorHandle ?? '',
    submission.canonicalUrl,
    submission.postedAt ? new Date(submission.postedAt * 1000).toISOString() : '',
    new Date(submission.createdAt).toISOString(),
    submission.decidedAt ? new Date(submission.decidedAt).toISOString() : '',
    submission.decidedByUserId ?? '',
    submission.viewsAtApproval ?? '',
    submission.latestViews ?? '',
    submission.latestViewsAt ? new Date(submission.latestViewsAt).toISOString() : '',
    submission.flags.join('|'),
  ]);

  return [COLUMNS.join(','), ...rows.map((row) => row.map(escapeCell).join(','))].join('\n');
}

function escapeCell(value: string | number): string {
  const text = String(value);
  // Quote when the value contains a delimiter, quote, or newline. Also guard
  // against spreadsheet formula injection from user-controlled captions.
  const needsQuotes = /[",\n\r]/.test(text);
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return needsQuotes ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
