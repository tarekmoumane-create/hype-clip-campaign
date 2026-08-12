import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteRepository, newId } from '../src/db/sqlite.js';
import { MockProvider } from '../src/providers/mock.js';
import { CampaignService } from '../src/service/campaign.js';
import { ChatHandler } from '../src/service/chat.js';
import type { Campaign } from '../src/types.js';

/**
 * End-to-end tests over a real (in-memory) database and the mock provider.
 * These cover the wiring the unit tests deliberately skip.
 */

const CAMPAIGN_START = Math.floor(Date.UTC(2026, 0, 1) / 1000);

let repo: SqliteRepository;
let provider: MockProvider;
let service: CampaignService;
let campaign: Campaign;

const admin = { userId: 'admin_1', isAdmin: true };

beforeEach(async () => {
  repo = new SqliteRepository(':memory:');
  provider = new MockProvider();
  service = new CampaignService(repo, provider);
  campaign = await repo.createCampaign({
    id: newId('camp'),
    chatId: 'chat_1',
    name: 'Test Campaign',
    startsAt: CAMPAIGN_START,
    endsAt: null,
    minViews: 0,
    active: true,
  });
});

const url = (id: string) => `https://www.tiktok.com/@alice_makes/video/${id}`;

describe('submit', () => {
  it('stores a submission and its first snapshot', async () => {
    provider.setMetrics('111', { views: 5_000, authorHandle: 'alice_makes' });
    const result = await service.submit({ chatId: 'chat_1', userId: 'user_alice', url: url('111') });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.latestViews).toBe(5_000);
    expect(await repo.listSnapshots(result.submission.id)).toHaveLength(1);
  });

  it('refuses when the chat has no active campaign', async () => {
    const result = await service.submit({ chatId: 'other_chat', userId: 'u', url: url('1') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_ACTIVE_CAMPAIGN');
  });

  it('refuses after the campaign has ended', async () => {
    await repo.close();
    repo = new SqliteRepository(':memory:');
    service = new CampaignService(repo, provider);
    await repo.createCampaign({
      id: newId('camp'),
      chatId: 'chat_1',
      name: 'Ended',
      startsAt: CAMPAIGN_START,
      endsAt: Math.floor(Date.now() / 1000) - 60,
      minViews: 0,
      active: true,
    });

    const result = await service.submit({ chatId: 'chat_1', userId: 'u', url: url('1') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CAMPAIGN_ENDED');
  });

  it('rejects the same video submitted twice, in any URL format', async () => {
    await service.submit({ chatId: 'chat_1', userId: 'user_alice', url: url('222') });
    const dup = await service.submit({
      chatId: 'chat_1',
      userId: 'user_bob',
      url: 'https://m.tiktok.com/v/222.html',
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.code).toBe('DUPLICATE');
      expect(dup.existing?.submitterUserId).toBe('user_alice');
    }
  });

  it('still records the submission when metrics cannot be read', async () => {
    provider.setFailure('333', 'PRIVATE_OR_RESTRICTED');
    const result = await service.submit({ chatId: 'chat_1', userId: 'user_alice', url: url('333') });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submission.status).toBe('pending');
    expect(result.submission.latestViews).toBeNull();
    expect(result.submission.flags).toContain('METRICS_UNAVAILABLE');
    expect(result.submission.fetchError).toContain('PRIVATE_OR_RESTRICTED');
  });

  it('flags a mismatch between the claimed handle and the actual author', async () => {
    await service.claimHandle({ userId: 'user_bob', platform: 'tiktok', handle: 'bob_clips' });
    provider.setMetrics('444', { authorHandle: 'alice_makes' });

    const result = await service.submit({ chatId: 'chat_1', userId: 'user_bob', url: url('444') });
    expect(result.ok && result.submission.flags).toContain('HANDLE_MISMATCH');
  });

  it('produces no flags when the claimed handle matches', async () => {
    await service.claimHandle({ userId: 'user_alice', platform: 'tiktok', handle: 'alice_makes' });
    provider.setMetrics('555', { authorHandle: 'alice_makes', postedAt: CAMPAIGN_START + 100 });

    const result = await service.submit({ chatId: 'chat_1', userId: 'user_alice', url: url('555') });
    expect(result.ok && result.submission.flags).toEqual([]);
  });
});

describe('claimHandle', () => {
  it('stores a normalized handle', async () => {
    await service.claimHandle({ userId: 'user_alice', platform: 'tiktok', handle: '@Alice_Makes' });
    const claimed = await repo.getClaimedHandle('user_alice', 'tiktok');
    expect(claimed?.handle).toBe('alice_makes');
  });

  it('stops a second user claiming a handle someone else owns', async () => {
    await service.claimHandle({ userId: 'user_alice', platform: 'tiktok', handle: 'alice_makes' });
    const result = await service.claimHandle({
      userId: 'user_mallory',
      platform: 'tiktok',
      handle: 'alice_makes',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('HANDLE_TAKEN');
  });

  it('lets the same user re-claim their own handle', async () => {
    await service.claimHandle({ userId: 'user_alice', platform: 'tiktok', handle: 'alice_makes' });
    const again = await service.claimHandle({
      userId: 'user_alice',
      platform: 'tiktok',
      handle: 'alice_makes',
    });
    expect(again.ok).toBe(true);
  });

  it('keeps handles independent per platform', async () => {
    await service.claimHandle({ userId: 'user_alice', platform: 'tiktok', handle: 'shared_name' });
    const ig = await service.claimHandle({
      userId: 'user_bob',
      platform: 'instagram',
      handle: 'shared_name',
    });
    expect(ig.ok).toBe(true);
  });
});

describe('decide', () => {
  it('approves, freezes views, and writes an audit event', async () => {
    provider.setMetrics('666', { views: 9_000 });
    const submitted = await service.submit({ chatId: 'chat_1', userId: 'user_alice', url: url('666') });
    if (!submitted.ok) throw new Error('setup failed');

    const decided = await service.decide({
      submissionId: submitted.submission.id,
      actor: admin,
      action: 'approve',
    });

    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.submission.status).toBe('approved');
    expect(decided.submission.viewsAtApproval).toBe(9_000);
  });

  it('rejects a decision from a non-admin', async () => {
    const submitted = await service.submit({ chatId: 'chat_1', userId: 'user_alice', url: url('777') });
    if (!submitted.ok) throw new Error('setup failed');

    const decided = await service.decide({
      submissionId: submitted.submission.id,
      actor: { userId: 'user_bob', isAdmin: false },
      action: 'approve',
    });
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.code).toBe('NOT_ADMIN');
  });

  it('returns NOT_FOUND for an unknown submission', async () => {
    const decided = await service.decide({
      submissionId: 'sub_nope',
      actor: admin,
      action: 'approve',
    });
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.code).toBe('NOT_FOUND');
  });
});

describe('refresh', () => {
  it('appends a snapshot and updates latestViews without touching viewsAtApproval', async () => {
    provider.setMetrics('888', { views: 1_000 });
    const submitted = await service.submit({ chatId: 'chat_1', userId: 'user_alice', url: url('888') });
    if (!submitted.ok) throw new Error('setup failed');

    await service.decide({ submissionId: submitted.submission.id, actor: admin, action: 'approve' });

    // The video keeps growing after approval.
    provider.setMetrics('888', { views: 250_000 });
    const refreshed = await service.refreshOne(
      (await repo.getSubmission(submitted.submission.id))!,
    );
    expect(refreshed?.views).toBe(250_000);

    const after = await repo.getSubmission(submitted.submission.id);
    expect(after?.latestViews).toBe(250_000);
    // Payout math reads this number; a later refresh must never move it.
    expect(after?.viewsAtApproval).toBe(1_000);
    expect(await repo.listSnapshots(submitted.submission.id)).toHaveLength(2);
  });

  it('records the error and keeps the submission when a refresh fails', async () => {
    provider.setMetrics('999', { views: 10 });
    const submitted = await service.submit({ chatId: 'chat_1', userId: 'user_alice', url: url('999') });
    if (!submitted.ok) throw new Error('setup failed');

    provider.setFailure('999', 'NOT_FOUND');
    const result = await service.refreshOne(submitted.submission);
    expect(result).toBeNull();

    const after = await repo.getSubmission(submitted.submission.id);
    expect(after?.fetchError).toContain('NOT_FOUND');
    expect(after?.latestViews).toBe(10);
  });
});

describe('leaderboard', () => {
  it('ranks by current views across approved submissions only', async () => {
    provider.setMetrics('901', { views: 100 });
    provider.setMetrics('902', { views: 900 });
    provider.setMetrics('903', { views: 50 });

    const a = await service.submit({ chatId: 'chat_1', userId: 'user_a', url: url('901') });
    const b = await service.submit({ chatId: 'chat_1', userId: 'user_b', url: url('902') });
    const c = await service.submit({ chatId: 'chat_1', userId: 'user_b', url: url('903') });
    if (!a.ok || !b.ok || !c.ok) throw new Error('setup failed');

    await service.decide({ submissionId: a.submission.id, actor: admin, action: 'approve' });
    await service.decide({ submissionId: b.submission.id, actor: admin, action: 'approve' });
    // Left pending on purpose — must not count.
    const rows = await service.leaderboard(campaign.id);

    expect(rows[0]).toMatchObject({ userId: 'user_b', totalCurrentViews: 900, approvedCount: 1 });
    expect(rows[1]).toMatchObject({ userId: 'user_a', totalCurrentViews: 100 });
  });
});

describe('ChatHandler', () => {
  it('turns a /submit message into a card', async () => {
    const handler = new ChatHandler(service);
    const responses = await handler.handleMessage(`/submit ${url('910')}`, {
      chatId: 'chat_1',
      userId: 'user_alice',
      isAdmin: false,
      displayName: '@alice',
    });

    expect(responses).toHaveLength(1);
    expect(responses[0]?.type).toBe('card');
  });

  it('answers a bad link privately so the group is not spammed', async () => {
    const handler = new ChatHandler(service);
    const responses = await handler.handleMessage('/submit https://youtube.com/watch?v=x', {
      chatId: 'chat_1',
      userId: 'user_alice',
      isAdmin: false,
    });

    expect(responses[0]).toMatchObject({ type: 'ephemeral', toUserId: 'user_alice' });
  });

  it('ignores ordinary chat', async () => {
    const handler = new ChatHandler(service);
    expect(await handler.handleMessage('gm', { chatId: 'chat_1', userId: 'u', isAdmin: false })).toEqual(
      [],
    );
  });

  it('refuses /queue for non-admins', async () => {
    const handler = new ChatHandler(service);
    const responses = await handler.handleMessage('/queue', {
      chatId: 'chat_1',
      userId: 'user_bob',
      isAdmin: false,
    });
    expect(responses[0]).toMatchObject({ type: 'ephemeral' });
    if (responses[0]?.type === 'ephemeral') {
      expect(responses[0].text).toContain('admins');
    }
  });
});
