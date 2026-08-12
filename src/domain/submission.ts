import type { Submission, SubmissionStatus } from '../types.js';

/**
 * Submission review state machine.
 *
 * pending ──approve──> approved
 *    │
 *    └───decline──> declined
 *
 * approved/declined are terminal for normal use. `reopen` exists because
 * admins misclick, and the alternative — deleting and resubmitting — loses the
 * view history we already collected.
 *
 * Every transition is pure: it takes a submission and returns a new one. The
 * caller persists the result. That keeps the rules testable without a database
 * and makes them trivial to port into the app's own stack.
 */

export type TransitionErrorCode =
  | 'NOT_ADMIN'
  | 'ALREADY_DECIDED'
  | 'NOT_DECIDED'
  | 'SELF_APPROVAL';

export interface TransitionFailure {
  ok: false;
  code: TransitionErrorCode;
  message: string;
}

export type TransitionResult =
  | { ok: true; value: Submission; previousStatus: SubmissionStatus }
  | TransitionFailure;

export interface Actor {
  userId: string;
  isAdmin: boolean;
}

export interface TransitionOptions {
  /** Unix ms. Injected for deterministic tests. */
  now?: number;
  /**
   * Whether an admin may approve a video they submitted themselves.
   * Off by default — if approvals map to rewards, self-approval is the first
   * thing anyone will try.
   */
  allowSelfApproval?: boolean;
}

export function approve(
  submission: Submission,
  actor: Actor,
  opts: TransitionOptions = {},
): TransitionResult {
  const now = opts.now ?? Date.now();

  if (!actor.isAdmin) {
    return { ok: false, code: 'NOT_ADMIN', message: 'Only campaign admins can approve submissions.' };
  }
  if (submission.status !== 'pending') {
    return {
      ok: false,
      code: 'ALREADY_DECIDED',
      message: `This submission was already ${submission.status}.`,
    };
  }
  if (!opts.allowSelfApproval && submission.submitterUserId === actor.userId) {
    return {
      ok: false,
      code: 'SELF_APPROVAL',
      message: 'You cannot approve your own submission. Ask another admin.',
    };
  }

  return {
    ok: true,
    previousStatus: submission.status,
    value: {
      ...submission,
      status: 'approved',
      decidedByUserId: actor.userId,
      decidedAt: now,
      declineReason: null,
      // Freeze the number the decision was made on. Later refreshes update
      // latestViews but must never move this — payouts reference it.
      viewsAtApproval: submission.latestViews,
      updatedAt: now,
    },
  };
}

export function decline(
  submission: Submission,
  actor: Actor,
  reason: string | null,
  opts: TransitionOptions = {},
): TransitionResult {
  const now = opts.now ?? Date.now();

  if (!actor.isAdmin) {
    return { ok: false, code: 'NOT_ADMIN', message: 'Only campaign admins can decline submissions.' };
  }
  if (submission.status !== 'pending') {
    return {
      ok: false,
      code: 'ALREADY_DECIDED',
      message: `This submission was already ${submission.status}.`,
    };
  }

  return {
    ok: true,
    previousStatus: submission.status,
    value: {
      ...submission,
      status: 'declined',
      decidedByUserId: actor.userId,
      decidedAt: now,
      declineReason: reason?.trim() || null,
      viewsAtApproval: null,
      updatedAt: now,
    },
  };
}

/** Returns a decided submission to the pending queue. Admin-only. */
export function reopen(
  submission: Submission,
  actor: Actor,
  opts: TransitionOptions = {},
): TransitionResult {
  const now = opts.now ?? Date.now();

  if (!actor.isAdmin) {
    return { ok: false, code: 'NOT_ADMIN', message: 'Only campaign admins can reopen submissions.' };
  }
  if (submission.status === 'pending') {
    return { ok: false, code: 'NOT_DECIDED', message: 'This submission is already pending.' };
  }

  return {
    ok: true,
    previousStatus: submission.status,
    value: {
      ...submission,
      status: 'pending',
      decidedByUserId: null,
      decidedAt: null,
      declineReason: null,
      viewsAtApproval: null,
      updatedAt: now,
    },
  };
}

/** Whether the given actor should see Approve/Decline controls on the card. */
export function canDecide(submission: Submission, actor: Actor): boolean {
  return actor.isAdmin && submission.status === 'pending';
}
