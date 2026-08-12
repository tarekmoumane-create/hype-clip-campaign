import { describe, expect, it } from 'vitest';
import { evaluateFlags, handlesMatch } from '../src/domain/fraud.js';
import type { VideoMetrics } from '../src/types.js';

const campaign = { startsAt: 1_759_000_000, minViews: 1_000 };

function metrics(overrides: Partial<VideoMetrics> = {}): VideoMetrics {
  return {
    platform: 'tiktok',
    externalId: '1',
    views: 12_431,
    likes: 500,
    comments: 20,
    shares: 5,
    authorHandle: 'alice_makes',
    authorDisplayName: 'Alice',
    postedAt: 1_759_500_000,
    caption: null,
    fetchedAt: Date.now(),
    source: 'mock',
    ...overrides,
  };
}

describe('handlesMatch', () => {
  it('matches regardless of case, @ prefix, or whitespace', () => {
    expect(handlesMatch('@Alice_Makes', 'alice_makes')).toBe(true);
    expect(handlesMatch(' alice_makes ', '@ALICE_MAKES')).toBe(true);
  });

  it('does not fuzzy-match similar handles', () => {
    // The whole point of the check: @nike and @nike_official are not the same
    // account, and treating them as one is the hole someone walks through.
    expect(handlesMatch('nike', 'nike_official')).toBe(false);
    expect(handlesMatch('alice', 'alicee')).toBe(false);
  });

  it('never matches an empty claim', () => {
    expect(handlesMatch('', 'alice')).toBe(false);
    expect(handlesMatch('@', 'alice')).toBe(false);
  });
});

describe('evaluateFlags', () => {
  it('returns no flags for a clean submission', () => {
    expect(evaluateFlags({ metrics: metrics(), claimedHandle: 'alice_makes', campaign })).toEqual([]);
  });

  it('flags a handle mismatch', () => {
    const flags = evaluateFlags({
      metrics: metrics({ authorHandle: 'someone_else' }),
      claimedHandle: 'alice_makes',
      campaign,
    });
    expect(flags).toContain('HANDLE_MISMATCH');
  });

  it('flags a user who never claimed a handle', () => {
    const flags = evaluateFlags({ metrics: metrics(), claimedHandle: null, campaign });
    expect(flags).toContain('NO_CLAIMED_HANDLE');
    expect(flags).not.toContain('HANDLE_MISMATCH');
  });

  it('flags a video posted before the campaign started', () => {
    const flags = evaluateFlags({
      metrics: metrics({ postedAt: campaign.startsAt - 1 }),
      claimedHandle: 'alice_makes',
      campaign,
    });
    expect(flags).toContain('POSTED_BEFORE_CAMPAIGN');
  });

  it('does not flag a video posted exactly at the start', () => {
    const flags = evaluateFlags({
      metrics: metrics({ postedAt: campaign.startsAt }),
      claimedHandle: 'alice_makes',
      campaign,
    });
    expect(flags).not.toContain('POSTED_BEFORE_CAMPAIGN');
  });

  it('flags views below the campaign minimum', () => {
    const flags = evaluateFlags({
      metrics: metrics({ views: 12 }),
      claimedHandle: 'alice_makes',
      campaign,
    });
    expect(flags).toContain('LOW_VIEWS');
  });

  it('skips the view minimum when it is zero', () => {
    const flags = evaluateFlags({
      metrics: metrics({ views: 0 }),
      claimedHandle: 'alice_makes',
      campaign: { startsAt: campaign.startsAt, minViews: 0 },
    });
    expect(flags).not.toContain('LOW_VIEWS');
  });

  it('flags unavailable metrics without inventing other conclusions', () => {
    const flags = evaluateFlags({ metrics: null, claimedHandle: 'alice_makes', campaign });
    expect(flags).toContain('METRICS_UNAVAILABLE');
    expect(flags).not.toContain('HANDLE_MISMATCH');
    expect(flags).not.toContain('LOW_VIEWS');
  });

  it('accumulates several flags at once', () => {
    const flags = evaluateFlags({
      metrics: metrics({ authorHandle: 'someone_else', views: 5, postedAt: campaign.startsAt - 1 }),
      claimedHandle: 'alice_makes',
      campaign,
    });
    expect(flags).toEqual(
      expect.arrayContaining(['HANDLE_MISMATCH', 'POSTED_BEFORE_CAMPAIGN', 'LOW_VIEWS']),
    );
  });
});
