import type { ParsedUrl, VideoMetrics } from '../types.js';
import { ProviderError, type ViewCountProvider } from './types.js';

/**
 * Scrape Creators adapter.
 *
 * Endpoints (verified live 2026-08-12):
 *   GET /v2/tiktok/video?url=...    -> aweme_detail.statistics.play_count
 *   GET /v1/instagram/post?url=...  -> data.xdt_shortcode_media.video_play_count
 *
 * Auth is an `x-api-key` header. Billing is 1 credit per uncached call;
 * Instagram supports `cache_max_age`, and a cache hit costs 0 credits, so the
 * refresh job passes it deliberately.
 *
 * Field paths are read defensively — vendors reshape responses without notice,
 * and a campaign should degrade to "views unavailable, admin decides" rather
 * than crash.
 */

export interface ScrapeCreatorsOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Passed to Instagram calls. A cache hit costs 0 credits. */
  igCacheMaxAge?: string;
  fetchImpl?: typeof fetch;
  /** Called after every response so callers can monitor credit burn. */
  onCredits?: (remaining: number | null, charged: number | null) => void;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Safely walks a dotted path, returning undefined at the first miss.
 *
 * Numeric segments index into arrays, which Instagram's response shape needs:
 * the caption lives at `edge_media_to_caption.edges.0.node.text`.
 */
function pick(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Returns the first path that yields a finite non-negative number. */
function pickNumber(root: unknown, paths: string[]): number | null {
  for (const path of paths) {
    const value = pick(root, path);
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

function pickString(root: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const value = pick(root, path);
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

export class ScrapeCreatorsProvider implements ViewCountProvider {
  readonly name = 'scrapecreators';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly igCacheMaxAge: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onCredits: ScrapeCreatorsOptions['onCredits'];

  constructor(opts: ScrapeCreatorsOptions) {
    if (!opts.apiKey) throw new Error('ScrapeCreatorsProvider requires an apiKey');
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://api.scrapecreators.com';
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.igCacheMaxAge = opts.igCacheMaxAge;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onCredits = opts.onCredits;
  }

  async fetchMetrics(parsed: ParsedUrl): Promise<VideoMetrics> {
    return parsed.platform === 'tiktok'
      ? this.fetchTikTok(parsed)
      : this.fetchInstagram(parsed);
  }

  private async request(path: string, params: Record<string, string>): Promise<Json> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      throw new ProviderError(
        aborted ? 'TIMEOUT' : 'UPSTREAM',
        aborted ? `Request timed out after ${this.timeoutMs}ms` : 'Network error calling provider',
        { retryable: true, cause },
      );
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text();

    if (!response.ok) {
      throw new ProviderError(
        statusToCode(response.status),
        `Provider returned ${response.status}: ${bodyText.slice(0, 300)}`,
        { status: response.status, retryable: response.status >= 500 || response.status === 429 },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch (cause) {
      throw new ProviderError('MALFORMED_RESPONSE', 'Provider returned non-JSON', { cause });
    }
    if (!isObject(body)) {
      throw new ProviderError('MALFORMED_RESPONSE', 'Provider returned a non-object body');
    }

    this.onCredits?.(
      typeof body.credits_remaining === 'number' ? body.credits_remaining : null,
      typeof body.credits_charged === 'number' ? body.credits_charged : null,
    );

    // The API answers 200 with `success: false` for some soft failures.
    if (body.success === false) {
      const message =
        typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : 'unknown error';
      throw new ProviderError(/not found|deleted/i.test(message) ? 'NOT_FOUND' : 'UPSTREAM', message);
    }

    return body;
  }

  private async fetchTikTok(parsed: ParsedUrl): Promise<VideoMetrics> {
    const body = await this.request('/v2/tiktok/video', { url: parsed.canonicalUrl });

    const detail = body.aweme_detail;
    if (!isObject(detail)) {
      throw new ProviderError('NOT_FOUND', 'Response contained no aweme_detail');
    }

    const views = pickNumber(detail, ['statistics.play_count', 'stats.play_count']);
    if (views === null) {
      throw new ProviderError('NO_VIEW_METRIC', 'No play_count on the TikTok response');
    }

    return {
      platform: 'tiktok',
      externalId: pickString(detail, ['aweme_id', 'statistics.aweme_id']) ?? parsed.externalId,
      views,
      likes: pickNumber(detail, ['statistics.digg_count']),
      comments: pickNumber(detail, ['statistics.comment_count']),
      shares: pickNumber(detail, ['statistics.share_count']),
      authorHandle: (pickString(detail, ['author.unique_id']) ?? '').toLowerCase(),
      authorDisplayName: pickString(detail, ['author.nickname']),
      postedAt: pickNumber(detail, ['create_time']),
      caption: pickString(detail, ['desc']),
      fetchedAt: Date.now(),
      source: this.name,
    };
  }

  private async fetchInstagram(parsed: ParsedUrl): Promise<VideoMetrics> {
    const params: Record<string, string> = { url: parsed.canonicalUrl };
    if (this.igCacheMaxAge) params.cache_max_age = this.igCacheMaxAge;

    const body = await this.request('/v1/instagram/post', params);

    // Documented path is data.xdt_shortcode_media; older payloads used
    // data.shortcode_media. Accept either, and the bare root as a last resort.
    const media =
      (isObject(body.data) && isObject(body.data.xdt_shortcode_media) && body.data.xdt_shortcode_media) ||
      (isObject(body.data) && isObject(body.data.shortcode_media) && body.data.shortcode_media) ||
      (isObject(body.xdt_shortcode_media) && body.xdt_shortcode_media) ||
      null;

    if (!media) {
      throw new ProviderError('NOT_FOUND', 'Response contained no shortcode_media');
    }

    const isVideo = media.is_video === true || typeof media.video_url === 'string';
    const views = pickNumber(media, [
      'video_play_count',
      'video_view_count',
      'play_count',
      'view_count',
    ]);

    if (views === null) {
      throw new ProviderError(
        isVideo ? 'NO_VIEW_METRIC' : 'NO_VIEW_METRIC',
        isVideo
          ? 'Instagram returned no play count for this video'
          : 'This Instagram post is not a video, so it has no play count',
      );
    }

    return {
      platform: 'instagram',
      externalId: pickString(media, ['shortcode']) ?? parsed.externalId,
      views,
      likes: pickNumber(media, ['edge_media_preview_like.count', 'edge_liked_by.count', 'like_count']),
      comments: pickNumber(media, ['edge_media_to_parent_comment.count', 'edge_media_to_comment.count', 'comment_count']),
      // Instagram does not expose a public share count.
      shares: null,
      authorHandle: (pickString(media, ['owner.username']) ?? '').toLowerCase(),
      authorDisplayName: pickString(media, ['owner.full_name']),
      postedAt: pickNumber(media, ['taken_at_timestamp', 'taken_at']),
      caption: pickString(media, ['edge_media_to_caption.edges.0.node.text', 'caption.text']),
      fetchedAt: Date.now(),
      source: this.name,
    };
  }
}

function statusToCode(status: number) {
  switch (status) {
    case 401:
    case 403:
      // 403 is overloaded: bad key, or age-restricted content. The message
      // body distinguishes them, but treating it as restricted is the safer
      // default because it is the far more common cause in practice.
      return status === 401 ? ('AUTH' as const) : ('PRIVATE_OR_RESTRICTED' as const);
    case 402:
      return 'INSUFFICIENT_CREDITS' as const;
    case 404:
      return 'NOT_FOUND' as const;
    case 429:
      return 'RATE_LIMITED' as const;
    default:
      return status >= 500 ? ('UPSTREAM' as const) : ('UPSTREAM' as const);
  }
}
