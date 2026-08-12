import { describe, expect, it } from 'vitest';
import { buildCard, formatViews } from '../src/render/card.js';
import { toCsv } from '../src/export/csv.js';
import type { Submission } from '../src/types.js';

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: 'sub_1',
    campaignId: 'camp_1',
    chatId: 'chat_1',
    messageId: null,
    submitterUserId: 'user_alice',
    platform: 'tiktok',
    originalUrl: 'https://www.tiktok.com/@alice/video/1',
    canonicalUrl: 'https://www.tiktok.com/@alice/video/1',
    externalId: '1',
    status: 'pending',
    flags: [],
    authorHandle: 'alice',
    postedAt: 1_737_673_396,
    caption: 'a clip',
    latestViews: 12_431,
    latestViewsAt: 1_760_000_000_000,
    viewsAtApproval: null,
    fetchError: null,
    decidedByUserId: null,
    decidedAt: null,
    declineReason: null,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    ...overrides,
  };
}

describe('formatViews', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1K'],
    [1_234, '1.2K'],
    [12_431, '12K'],
    [999_999, '1000K'],
    [1_856_732, '1.9M'],
    [2_400_000_000, '2.4B'],
  ])('formats %i as %s', (input, expected) => {
    expect(formatViews(input)).toBe(expected);
  });

  it('shows a dash when views are unknown', () => {
    expect(formatViews(null)).toBe('—');
  });
});

describe('admin controls', () => {
  it('gives admins approve and decline on a pending submission', () => {
    const card = buildCard(submission(), { viewerIsAdmin: true, viewerUserId: 'admin_1' });
    expect(card.actions.map((a) => a.id)).toEqual(['approve', 'decline']);
  });

  it('gives ordinary members no actions at all', () => {
    const card = buildCard(submission(), { viewerIsAdmin: false, viewerUserId: 'user_bob' });
    expect(card.actions).toEqual([]);
  });

  it('withholds approve from an admin looking at their own submission', () => {
    const card = buildCard(submission({ submitterUserId: 'admin_1' }), {
      viewerIsAdmin: true,
      viewerUserId: 'admin_1',
    });
    expect(card.actions).toEqual([]);
  });

  it('offers reopen once a submission is decided', () => {
    const card = buildCard(submission({ status: 'approved', decidedByUserId: 'admin_1' }), {
      viewerIsAdmin: true,
      viewerUserId: 'admin_1',
    });
    expect(card.actions.map((a) => a.id)).toEqual(['reopen']);
  });

  it('marks decline as needing confirmation', () => {
    const card = buildCard(submission(), { viewerIsAdmin: true, viewerUserId: 'admin_1' });
    expect(card.actions.find((a) => a.id === 'decline')?.confirm).toBe(true);
  });
});

describe('card content', () => {
  it('raises severity for a handle mismatch', () => {
    const card = buildCard(submission({ flags: ['HANDLE_MISMATCH'] }), { viewerIsAdmin: true });
    expect(card.flags[0]).toMatchObject({ code: 'HANDLE_MISMATCH', severity: 'warning' });
    expect(card.statusLabel).toBe('Pending — needs a look');
  });

  it('keeps an informational flag at info severity', () => {
    const card = buildCard(submission({ flags: ['NO_CLAIMED_HANDLE'] }), { viewerIsAdmin: true });
    expect(card.flags[0]?.severity).toBe('info');
    expect(card.statusLabel).toBe('Pending review');
  });

  it('surfaces the decline reason in the status line', () => {
    const card = buildCard(
      submission({ status: 'declined', declineReason: 'not on brand', decidedByUserId: 'admin_1' }),
      { viewerIsAdmin: false },
    );
    expect(card.statusLabel).toBe('Declined — not on brand');
  });

  it('truncates a long caption', () => {
    const card = buildCard(submission({ caption: 'x'.repeat(500) }), { viewerIsAdmin: false });
    expect(card.caption!.length).toBeLessThanOrEqual(120);
    expect(card.caption!.endsWith('…')).toBe(true);
  });

  it('always includes a plain-text fallback', () => {
    const card = buildCard(submission(), { viewerIsAdmin: false, submitterLabel: '@alice' });
    expect(card.fallbackText).toContain('@alice');
    expect(card.fallbackText).toContain('12K');
  });
});

describe('CSV export', () => {
  it('emits a header and one row per submission', () => {
    const csv = toCsv([submission({ status: 'approved', viewsAtApproval: 12_431 })]);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('views_at_approval');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('12431');
  });

  it('quotes values containing commas', () => {
    const csv = toCsv([submission({ declineReason: 'a, b', authorHandle: 'x,y' })]);
    expect(csv).toContain('"x,y"');
  });

  it('neutralizes spreadsheet formula injection', () => {
    // A caption or handle starting with = would execute on open in Excel.
    const csv = toCsv([submission({ authorHandle: '=cmd|calc' })]);
    expect(csv).toContain("'=cmd|calc");
  });
});
