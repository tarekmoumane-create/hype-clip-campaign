import { describe, expect, it } from 'vitest';
import {
  detectPlatform,
  extractFirstUrl,
  isShortLink,
  normalizeHandle,
  parseCanonicalUrl,
  parseSubmittedUrl,
} from '../src/parse/url.js';

describe('parseCanonicalUrl — TikTok', () => {
  it('pulls the video id and handle from a standard URL', () => {
    const parsed = parseCanonicalUrl(
      'https://www.tiktok.com/@stoolpresidente/video/7463250363559218474',
    );
    expect(parsed).toMatchObject({
      platform: 'tiktok',
      externalId: '7463250363559218474',
      handleFromUrl: 'stoolpresidente',
      canonicalUrl: 'https://www.tiktok.com/@stoolpresidente/video/7463250363559218474',
    });
  });

  it('handles photo posts, which share the video id space', () => {
    const parsed = parseCanonicalUrl('https://www.tiktok.com/@someone/photo/7463250363559218474');
    expect(parsed?.externalId).toBe('7463250363559218474');
  });

  it('handles the m.tiktok.com /v/<id>.html form', () => {
    const parsed = parseCanonicalUrl('https://m.tiktok.com/v/7463250363559218474.html');
    expect(parsed?.externalId).toBe('7463250363559218474');
  });

  it('accepts handles containing dots and underscores', () => {
    const parsed = parseCanonicalUrl('https://www.tiktok.com/@a.b_c/video/123');
    expect(parsed?.handleFromUrl).toBe('a.b_c');
  });

  it('rejects a profile URL with no video', () => {
    expect(parseCanonicalUrl('https://www.tiktok.com/@someone')).toBeNull();
  });
});

describe('parseCanonicalUrl — Instagram', () => {
  it.each([
    ['https://www.instagram.com/reel/Cx1y2Z3aBcD/', 'Cx1y2Z3aBcD'],
    ['https://www.instagram.com/reels/Cx1y2Z3aBcD/', 'Cx1y2Z3aBcD'],
    ['https://www.instagram.com/p/Cx1y2Z3aBcD/', 'Cx1y2Z3aBcD'],
    ['https://www.instagram.com/tv/Cx1y2Z3aBcD/', 'Cx1y2Z3aBcD'],
    ['https://instagram.com/reel/Cx1y2Z3aBcD', 'Cx1y2Z3aBcD'],
  ])('extracts the shortcode from %s', (input, expected) => {
    expect(parseCanonicalUrl(input)?.externalId).toBe(expected);
  });

  it('extracts the shortcode from the /<username>/reel/<code> form', () => {
    const parsed = parseCanonicalUrl('https://www.instagram.com/someuser/reel/Cx1y2Z3aBcD/');
    expect(parsed?.externalId).toBe('Cx1y2Z3aBcD');
  });

  it('preserves shortcode case — shortcodes are case sensitive', () => {
    const parsed = parseCanonicalUrl('https://www.instagram.com/reel/AbCdEfG/');
    expect(parsed?.externalId).toBe('AbCdEfG');
  });

  it('rejects a profile URL', () => {
    expect(parseCanonicalUrl('https://www.instagram.com/someuser/')).toBeNull();
  });
});

describe('canonicalization', () => {
  it('strips TikTok share-sheet tracking params', async () => {
    const result = await parseSubmittedUrl(
      'https://www.tiktok.com/@user/video/123?is_from_webapp=1&sender_device=pc&web_id=999',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.canonicalUrl).toBe('https://www.tiktok.com/@user/video/123');
    }
  });

  it('strips the Instagram igsh param', async () => {
    const result = await parseSubmittedUrl('https://www.instagram.com/reel/AbCdEfG/?igsh=xyz123');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.canonicalUrl).toBe('https://www.instagram.com/reel/AbCdEfG');
    }
  });

  it('gives the same external id for two different URL formats of one video', async () => {
    const a = await parseSubmittedUrl('https://www.tiktok.com/@user/video/123?is_from_webapp=1');
    const b = await parseSubmittedUrl('https://m.tiktok.com/v/123.html');
    expect(a.ok && b.ok && a.value.externalId === b.value.externalId).toBe(true);
  });

  it('accepts a bare URL with no scheme', async () => {
    const result = await parseSubmittedUrl('tiktok.com/@user/video/123');
    expect(result.ok).toBe(true);
  });
});

describe('short links', () => {
  it('recognizes vm./vt. hosts and the /t/ path', () => {
    expect(isShortLink(new URL('https://vm.tiktok.com/ZMabc/'))).toBe(true);
    expect(isShortLink(new URL('https://vt.tiktok.com/ZSabc/'))).toBe(true);
    expect(isShortLink(new URL('https://www.tiktok.com/t/ZTabc/'))).toBe(true);
    expect(isShortLink(new URL('https://www.tiktok.com/@u/video/1'))).toBe(false);
  });

  it('resolves a short link and marks the result', async () => {
    const fetchImpl = (async () =>
      ({
        url: 'https://www.tiktok.com/@resolved/video/7463250363559218474',
      }) as Response) as unknown as typeof fetch;

    const result = await parseSubmittedUrl('https://vm.tiktok.com/ZMabc/', { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.externalId).toBe('7463250363559218474');
      expect(result.value.wasShortLink).toBe(true);
    }
  });

  it('fails cleanly when a short link cannot be resolved', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await parseSubmittedUrl('https://vm.tiktok.com/ZMabc/', { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SHORTLINK_RESOLUTION_FAILED');
  });
});

describe('rejections', () => {
  it('rejects a non-URL', async () => {
    const result = await parseSubmittedUrl('hello there');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_A_URL');
  });

  it('rejects an unsupported platform', async () => {
    const result = await parseSubmittedUrl('https://www.youtube.com/watch?v=abc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('rejects a lookalike domain', async () => {
    // tiktok.com.evil.com must not be treated as TikTok.
    const result = await parseSubmittedUrl('https://tiktok.com.evil.com/@u/video/1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('rejects a javascript: URL', async () => {
    const result = await parseSubmittedUrl('javascript:alert(1)');
    expect(result.ok).toBe(false);
  });
});

describe('helpers', () => {
  it('extracts the first URL from a sentence', () => {
    expect(extractFirstUrl('check this https://www.tiktok.com/@u/video/1 out')).toBe(
      'https://www.tiktok.com/@u/video/1',
    );
  });

  it('trims trailing punctuation from a pasted link', () => {
    expect(extractFirstUrl('see https://www.tiktok.com/@u/video/1.')).toBe(
      'https://www.tiktok.com/@u/video/1',
    );
  });

  it('returns null when there is no URL', () => {
    expect(extractFirstUrl('no links here')).toBeNull();
  });

  it('normalizes handles', () => {
    expect(normalizeHandle('  @Alice_Makes ')).toBe('alice_makes');
    expect(normalizeHandle('@@double')).toBe('double');
  });

  it('detects platform by host', () => {
    expect(detectPlatform(new URL('https://www.tiktok.com/x'))).toBe('tiktok');
    expect(detectPlatform(new URL('https://instagr.am/p/x'))).toBe('instagram');
    expect(detectPlatform(new URL('https://example.com'))).toBeNull();
  });
});
