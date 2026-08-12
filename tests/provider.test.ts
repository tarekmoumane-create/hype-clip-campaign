import { describe, expect, it, vi } from 'vitest';
import { ScrapeCreatorsProvider } from '../src/providers/scrapecreators.js';
import { RetryingProvider, ProviderError } from '../src/providers/index.js';
import type { ParsedUrl } from '../src/types.js';

/**
 * These fixtures mirror the real API's shape, captured from live calls on
 * 2026-08-12. If the vendor reshapes a response, these tests are what tells
 * you before your campaign does.
 */

const TIKTOK_URL: ParsedUrl = {
  platform: 'tiktok',
  externalId: '7463250363559218474',
  canonicalUrl: 'https://www.tiktok.com/@stoolpresidente/video/7463250363559218474',
  wasShortLink: false,
};

const INSTAGRAM_URL: ParsedUrl = {
  platform: 'instagram',
  externalId: 'Cx1y2Z3aBcD',
  canonicalUrl: 'https://www.instagram.com/reel/Cx1y2Z3aBcD',
  wasShortLink: false,
};

const TIKTOK_BODY = {
  success: true,
  credits_remaining: 81,
  credits_charged: 1,
  aweme_detail: {
    aweme_id: '7463250363559218474',
    desc: 'Stopped by the viral pizza place',
    create_time: 1_737_673_396,
    author: { unique_id: 'stoolpresidente', nickname: 'Dave Portnoy' },
    statistics: {
      play_count: 1_856_732,
      digg_count: 174_265,
      comment_count: 591,
      share_count: 6_953,
    },
  },
};

const INSTAGRAM_BODY = {
  success: true,
  credits_remaining: 80,
  data: {
    xdt_shortcode_media: {
      id: '3123456789',
      shortcode: 'Cx1y2Z3aBcD',
      is_video: true,
      video_url: 'https://scontent.cdninstagram.com/v.mp4',
      video_play_count: 88_204,
      video_view_count: 74_110,
      taken_at_timestamp: 1_737_673_396,
      owner: { username: 'alice_makes', full_name: 'Alice' },
      edge_media_preview_like: { count: 4_120 },
      edge_media_to_parent_comment: { count: 88 },
      edge_media_to_caption: { edges: [{ node: { text: 'my clip' } }] },
    },
  },
};

function stubFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

function provider(fetchImpl: typeof fetch) {
  return new ScrapeCreatorsProvider({ apiKey: 'test_key', fetchImpl });
}

describe('TikTok mapping', () => {
  it('maps play_count to views and reads the author', async () => {
    const metrics = await provider(stubFetch(TIKTOK_BODY)).fetchMetrics(TIKTOK_URL);
    expect(metrics).toMatchObject({
      platform: 'tiktok',
      externalId: '7463250363559218474',
      views: 1_856_732,
      likes: 174_265,
      comments: 591,
      shares: 6_953,
      authorHandle: 'stoolpresidente',
      authorDisplayName: 'Dave Portnoy',
      postedAt: 1_737_673_396,
      source: 'scrapecreators',
    });
  });

  it('lowercases the author handle so comparisons are stable', async () => {
    const body = structuredClone(TIKTOK_BODY);
    body.aweme_detail.author.unique_id = 'StoolPresidente';
    const metrics = await provider(stubFetch(body)).fetchMetrics(TIKTOK_URL);
    expect(metrics.authorHandle).toBe('stoolpresidente');
  });

  it('sends the API key as x-api-key', async () => {
    const fetchImpl = stubFetch(TIKTOK_BODY);
    await provider(fetchImpl).fetchMetrics(TIKTOK_URL);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('test_key');
  });

  it('raises NO_VIEW_METRIC when play_count is missing', async () => {
    const body = structuredClone(TIKTOK_BODY);
    delete (body.aweme_detail.statistics as Record<string, unknown>).play_count;
    await expect(provider(stubFetch(body)).fetchMetrics(TIKTOK_URL)).rejects.toMatchObject({
      code: 'NO_VIEW_METRIC',
    });
  });

  it('raises NOT_FOUND when aweme_detail is absent', async () => {
    await expect(
      provider(stubFetch({ success: true })).fetchMetrics(TIKTOK_URL),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('Instagram mapping', () => {
  it('prefers video_play_count over video_view_count', async () => {
    // Plays and views are different numbers on Instagram. The campaign is
    // scored on plays, so a silent fallback to the smaller number would
    // quietly understate every entry.
    const metrics = await provider(stubFetch(INSTAGRAM_BODY)).fetchMetrics(INSTAGRAM_URL);
    expect(metrics.views).toBe(88_204);
  });

  it('falls back to video_view_count when play count is absent', async () => {
    const body = structuredClone(INSTAGRAM_BODY);
    delete (body.data.xdt_shortcode_media as Record<string, unknown>).video_play_count;
    const metrics = await provider(stubFetch(body)).fetchMetrics(INSTAGRAM_URL);
    expect(metrics.views).toBe(74_110);
  });

  it('reads the older shortcode_media shape too', async () => {
    const body = { success: true, data: { shortcode_media: INSTAGRAM_BODY.data.xdt_shortcode_media } };
    const metrics = await provider(stubFetch(body)).fetchMetrics(INSTAGRAM_URL);
    expect(metrics.views).toBe(88_204);
  });

  it('maps likes, comments, caption and owner', async () => {
    const metrics = await provider(stubFetch(INSTAGRAM_BODY)).fetchMetrics(INSTAGRAM_URL);
    expect(metrics).toMatchObject({
      likes: 4_120,
      comments: 88,
      caption: 'my clip',
      authorHandle: 'alice_makes',
      shares: null,
    });
  });

  it('passes cache_max_age so repeat reads are free', async () => {
    const fetchImpl = stubFetch(INSTAGRAM_BODY);
    const p = new ScrapeCreatorsProvider({ apiKey: 'k', fetchImpl, igCacheMaxAge: '7d' });
    await p.fetchMetrics(INSTAGRAM_URL);
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('cache_max_age=7d');
  });

  it('raises NO_VIEW_METRIC for a photo post', async () => {
    const body = {
      success: true,
      data: { xdt_shortcode_media: { shortcode: 'X', is_video: false, owner: { username: 'a' } } },
    };
    await expect(provider(stubFetch(body)).fetchMetrics(INSTAGRAM_URL)).rejects.toMatchObject({
      code: 'NO_VIEW_METRIC',
    });
  });
});

describe('HTTP error mapping', () => {
  it.each([
    [404, 'NOT_FOUND', false],
    [403, 'PRIVATE_OR_RESTRICTED', false],
    [401, 'AUTH', false],
    [402, 'INSUFFICIENT_CREDITS', false],
    [429, 'RATE_LIMITED', true],
    [500, 'UPSTREAM', true],
  ])('maps HTTP %i to %s', async (status, code, retryable) => {
    const fetchImpl = vi.fn(async () => new Response('err', { status })) as unknown as typeof fetch;
    await expect(provider(fetchImpl).fetchMetrics(TIKTOK_URL)).rejects.toMatchObject({
      code,
      retryable,
    });
  });

  it('treats a 200 with success:false as a failure', async () => {
    await expect(
      provider(stubFetch({ success: false, error: 'video not found' })).fetchMetrics(TIKTOK_URL),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('raises MALFORMED_RESPONSE for non-JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    await expect(provider(fetchImpl).fetchMetrics(TIKTOK_URL)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('reports credits back to the caller', async () => {
    const onCredits = vi.fn();
    const p = new ScrapeCreatorsProvider({ apiKey: 'k', fetchImpl: stubFetch(TIKTOK_BODY), onCredits });
    await p.fetchMetrics(TIKTOK_URL);
    expect(onCredits).toHaveBeenCalledWith(81, 1);
  });

  it('produces user-safe copy for every error code', () => {
    for (const code of ['NOT_FOUND', 'PRIVATE_OR_RESTRICTED', 'RATE_LIMITED', 'AUTH'] as const) {
      expect(new ProviderError(code, 'internal detail').userMessage()).not.toContain('internal detail');
    }
  });
});

describe('RetryingProvider', () => {
  it('retries retryable failures then succeeds', async () => {
    let calls = 0;
    const flaky = {
      name: 'flaky',
      async fetchMetrics() {
        calls++;
        if (calls < 3) throw new ProviderError('RATE_LIMITED', 'slow down', { retryable: true });
        return { views: 1 } as never;
      },
    };
    const p = new RetryingProvider(flaky, { attempts: 3, sleep: async () => {} });
    await expect(p.fetchMetrics(TIKTOK_URL)).resolves.toBeDefined();
    expect(calls).toBe(3);
  });

  it('does not retry a permanent failure', async () => {
    let calls = 0;
    const dead = {
      name: 'dead',
      async fetchMetrics(): Promise<never> {
        calls++;
        throw new ProviderError('NOT_FOUND', 'gone');
      },
    };
    const p = new RetryingProvider(dead, { attempts: 3, sleep: async () => {} });
    await expect(p.fetchMetrics(TIKTOK_URL)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toBe(1);
  });
});
