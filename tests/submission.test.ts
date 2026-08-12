import { describe, expect, it } from 'vitest';
import { approve, canDecide, decline, reopen } from '../src/domain/submission.js';
import type { Submission } from '../src/types.js';

const NOW = 1_760_000_000_000;

function pending(overrides: Partial<Submission> = {}): Submission {
  return {
    id: 'sub_1',
    campaignId: 'camp_1',
    chatId: 'chat_1',
    messageId: 'msg_1',
    submitterUserId: 'user_alice',
    platform: 'tiktok',
    originalUrl: 'https://www.tiktok.com/@alice/video/1',
    canonicalUrl: 'https://www.tiktok.com/@alice/video/1',
    externalId: '1',
    status: 'pending',
    flags: [],
    authorHandle: 'alice',
    postedAt: 1_759_000_000,
    caption: null,
    latestViews: 12_431,
    latestViewsAt: NOW - 1000,
    viewsAtApproval: null,
    fetchError: null,
    decidedByUserId: null,
    decidedAt: null,
    declineReason: null,
    createdAt: NOW - 5000,
    updatedAt: NOW - 5000,
    ...overrides,
  };
}

const admin = { userId: 'admin_1', isAdmin: true };
const member = { userId: 'user_bob', isAdmin: false };

describe('approve', () => {
  it('moves pending to approved and records the decider', () => {
    const result = approve(pending(), admin, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('approved');
    expect(result.value.decidedByUserId).toBe('admin_1');
    expect(result.value.decidedAt).toBe(NOW);
  });

  it('freezes the view count at the moment of approval', () => {
    const result = approve(pending({ latestViews: 12_431 }), admin, { now: NOW });
    expect(result.ok && result.value.viewsAtApproval).toBe(12_431);
  });

  it('refuses a non-admin', () => {
    const result = approve(pending(), member, { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_ADMIN');
  });

  it('refuses to approve twice', () => {
    const first = approve(pending(), admin, { now: NOW });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = approve(first.value, admin, { now: NOW + 1 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('ALREADY_DECIDED');
  });

  it('refuses to approve a declined submission', () => {
    const declined = decline(pending(), admin, null, { now: NOW });
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;
    const result = approve(declined.value, admin, { now: NOW + 1 });
    expect(result.ok).toBe(false);
  });

  it('blocks an admin approving their own submission by default', () => {
    const own = pending({ submitterUserId: 'admin_1' });
    const result = approve(own, admin, { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SELF_APPROVAL');
  });

  it('allows self-approval when explicitly enabled', () => {
    const own = pending({ submitterUserId: 'admin_1' });
    const result = approve(own, admin, { now: NOW, allowSelfApproval: true });
    expect(result.ok).toBe(true);
  });

  it('does not mutate the input', () => {
    const original = pending();
    approve(original, admin, { now: NOW });
    expect(original.status).toBe('pending');
    expect(original.viewsAtApproval).toBeNull();
  });
});

describe('decline', () => {
  it('records the reason', () => {
    const result = decline(pending(), admin, '  not on brand  ', { now: NOW });
    expect(result.ok && result.value.declineReason).toBe('not on brand');
  });

  it('stores null for an empty reason rather than an empty string', () => {
    const result = decline(pending(), admin, '   ', { now: NOW });
    expect(result.ok && result.value.declineReason).toBeNull();
  });

  it('leaves viewsAtApproval unset', () => {
    const result = decline(pending(), admin, null, { now: NOW });
    expect(result.ok && result.value.viewsAtApproval).toBeNull();
  });

  it('lets an admin decline their own submission', () => {
    // Only approval is self-dealing; declining your own entry harms no one.
    const own = pending({ submitterUserId: 'admin_1' });
    expect(decline(own, admin, null, { now: NOW }).ok).toBe(true);
  });

  it('refuses a non-admin', () => {
    expect(decline(pending(), member, null, { now: NOW }).ok).toBe(false);
  });
});

describe('reopen', () => {
  it('returns an approved submission to pending and clears the decision', () => {
    const approved = approve(pending(), admin, { now: NOW });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;

    const result = reopen(approved.value, admin, { now: NOW + 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending');
    expect(result.value.decidedByUserId).toBeNull();
    expect(result.value.decidedAt).toBeNull();
    expect(result.value.viewsAtApproval).toBeNull();
  });

  it('refuses when the submission is already pending', () => {
    const result = reopen(pending(), admin, { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_DECIDED');
  });

  it('refuses a non-admin', () => {
    const approved = approve(pending(), admin, { now: NOW });
    if (!approved.ok) return;
    expect(reopen(approved.value, member, { now: NOW }).ok).toBe(false);
  });
});

describe('canDecide', () => {
  it('is true only for admins on pending submissions', () => {
    expect(canDecide(pending(), admin)).toBe(true);
    expect(canDecide(pending(), member)).toBe(false);
    expect(canDecide(pending({ status: 'approved' }), admin)).toBe(false);
  });
});
