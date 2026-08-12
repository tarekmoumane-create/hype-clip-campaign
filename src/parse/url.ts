import type { ParsedUrl, Platform } from '../types.js';

/**
 * URL parsing and canonicalization for submitted clips.
 *
 * Two jobs:
 *   1. Decide which platform a link belongs to and pull out a stable id, so
 *      the same video submitted twice in two different link formats is caught
 *      as a duplicate.
 *   2. Strip the tracking junk that share sheets append, so what we store and
 *      display is clean.
 *
 * Everything here is pure except `resolveShortLink`, which makes one request.
 */

export type ParseErrorCode =
  | 'NOT_A_URL'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNRECOGNIZED_URL_SHAPE'
  | 'SHORTLINK_RESOLUTION_FAILED';

export interface ParseFailure {
  ok: false;
  code: ParseErrorCode;
  /** Copy safe to show the submitter in chat. */
  message: string;
}

export type ParseResult = { ok: true; value: ParsedUrl } | ParseFailure;

const TIKTOK_HOSTS = new Set([
  'tiktok.com',
  'www.tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
]);

const INSTAGRAM_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'instagr.am',
  'www.instagr.am',
]);

/** Hosts that redirect to the real post URL and must be resolved first. */
const SHORT_LINK_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com', 'instagr.am', 'www.instagr.am']);

/** TikTok's `/t/CODE` path is also a redirect, on an otherwise normal host. */
const TIKTOK_SHORT_PATH = /^\/t\/[A-Za-z0-9]+\/?$/;

const TRACKING_PARAMS = new Set([
  'is_from_webapp',
  'sender_device',
  'sender_web_id',
  'web_id',
  'refer',
  'referer_url',
  'referer_video_id',
  'is_copy_url',
  '_r',
  '_t',
  '_d',
  'checksum',
  'share_app_id',
  'share_item_id',
  'share_link_id',
  'timestamp',
  'user_id',
  'tt_from',
  'source',
  'igsh',
  'igshid',
  'img_index',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
]);

/** Pulls the first http(s) URL out of a chat message. */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (!match) return null;
  // Trim trailing punctuation people type after a pasted link.
  return match[0].replace(/[.,;:!?]+$/, '');
}

function toUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Accept bare "tiktok.com/@x/video/1" by assuming https.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

export function detectPlatform(url: URL): Platform | null {
  const host = url.hostname.toLowerCase();
  if (TIKTOK_HOSTS.has(host)) return 'tiktok';
  if (INSTAGRAM_HOSTS.has(host)) return 'instagram';
  return null;
}

export function isShortLink(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (SHORT_LINK_HOSTS.has(host)) return true;
  if (TIKTOK_HOSTS.has(host) && TIKTOK_SHORT_PATH.test(url.pathname)) return true;
  return false;
}

/**
 * Follows a share-sheet short link to the canonical post URL.
 *
 * TikTok's vm./vt. links answer HEAD with a 301, but some edges only redirect
 * on GET, so we fall back. We never read the body.
 */
export async function resolveShortLink(
  input: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  for (const method of ['HEAD', 'GET'] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(input, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          // Short-link hosts serve a JS bounce page to unknown agents.
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        },
      });
      if (res.url && res.url !== input) return res.url;
    } catch {
      // fall through to the next method
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function canonicalize(url: URL): string {
  const cleaned = new URL(url.toString());
  for (const param of [...cleaned.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(param.toLowerCase())) cleaned.searchParams.delete(param);
  }
  cleaned.hash = '';
  const query = cleaned.searchParams.toString();
  const path = cleaned.pathname.replace(/\/+$/, '');
  return `https://${cleaned.hostname.toLowerCase()}${path}${query ? `?${query}` : ''}`;
}

const TIKTOK_VIDEO_PATH = /^\/@([A-Za-z0-9._]+)\/(?:video|photo)\/(\d+)/;
const TIKTOK_MOBILE_PATH = /^\/v\/(\d+)(?:\.html)?/;
const INSTAGRAM_MEDIA_PATH = /(?:^|\/)(?:reels?|p|tv|share\/reel)\/([A-Za-z0-9_-]+)/;

/**
 * Parses an already-canonical (non-short) URL. Pure — no network.
 * Returns null if the shape is not a recognizable post URL.
 */
export function parseCanonicalUrl(input: string): ParsedUrl | null {
  const url = toUrl(input);
  if (!url) return null;
  const platform = detectPlatform(url);
  if (!platform) return null;

  if (platform === 'tiktok') {
    const full = url.pathname.match(TIKTOK_VIDEO_PATH);
    if (full) {
      const handle = full[1];
      const id = full[2];
      if (!id) return null;
      return {
        platform,
        externalId: id,
        canonicalUrl: `https://www.tiktok.com/@${handle}/video/${id}`,
        handleFromUrl: handle?.toLowerCase(),
        wasShortLink: false,
      };
    }
    const mobile = url.pathname.match(TIKTOK_MOBILE_PATH);
    if (mobile?.[1]) {
      return {
        platform,
        externalId: mobile[1],
        // Without a handle we cannot build the pretty form; the id form works.
        canonicalUrl: `https://www.tiktok.com/video/${mobile[1]}`,
        wasShortLink: false,
      };
    }
    return null;
  }

  const media = url.pathname.match(INSTAGRAM_MEDIA_PATH);
  if (media?.[1]) {
    const shortcode = media[1];
    // Instagram serves any media type from /reel/<code>; keep the shape the
    // user gave us so the canonical link opens the way they expect.
    const kind = /\/(reels?|share\/reel)\//.test(url.pathname) ? 'reel' : 'p';
    return {
      platform: 'instagram',
      externalId: shortcode,
      canonicalUrl: `https://www.instagram.com/${kind}/${shortcode}`,
      wasShortLink: false,
    };
  }
  return null;
}

/**
 * Full parse, resolving share-sheet short links over the network when needed.
 * This is what the submission pipeline calls.
 */
export async function parseSubmittedUrl(
  input: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ParseResult> {
  const url = toUrl(input);
  if (!url) {
    return { ok: false, code: 'NOT_A_URL', message: "That doesn't look like a link." };
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return {
      ok: false,
      code: 'UNSUPPORTED_PLATFORM',
      message: 'Only TikTok and Instagram links are accepted right now.',
    };
  }

  if (isShortLink(url)) {
    const resolved = await resolveShortLink(url.toString(), opts);
    if (!resolved) {
      return {
        ok: false,
        code: 'SHORTLINK_RESOLUTION_FAILED',
        message:
          'Could not open that short link. Paste the full link from the post instead.',
      };
    }
    const parsed = parseCanonicalUrl(canonicalize(new URL(resolved)));
    if (!parsed) {
      return {
        ok: false,
        code: 'UNRECOGNIZED_URL_SHAPE',
        message: 'That link resolved to something that is not a video post.',
      };
    }
    return { ok: true, value: { ...parsed, wasShortLink: true } };
  }

  const parsed = parseCanonicalUrl(canonicalize(url));
  if (!parsed) {
    return {
      ok: false,
      code: 'UNRECOGNIZED_URL_SHAPE',
      message:
        'That link is not a video post. Use the link to the video itself, not a profile.',
    };
  }
  return { ok: true, value: parsed };
}

/** Normalizes a handle for comparison: lowercase, no leading @, no spaces. */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '').toLowerCase();
}
