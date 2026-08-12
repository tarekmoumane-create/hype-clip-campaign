import type {
  Campaign,
  Platform,
  Submission,
  SubmissionFlag,
  VideoMetrics,
} from '../types.js';
import type { LeaderboardRow, Repository } from '../db/repo.js';
import { newId } from '../db/sqlite.js';
import { parseSubmittedUrl, normalizeHandle } from '../parse/url.js';
import { evaluateFlags } from '../domain/fraud.js';
import { approve, decline, reopen, type Actor } from '../domain/submission.js';
import { ProviderError, type ViewCountProvider } from '../providers/index.js';

/**
 * Orchestrates the whole flow: parse a submitted link, read its metrics,
 * check ownership, persist, and hand back something the chat can render.
 *
 * This layer is where "what happens" lives. The domain modules hold the rules,
 * the repository holds the data, the provider holds the numbers — this ties
 * the three together and is the piece the app's chat handler calls into.
 */

export type SubmitResult =
  | { ok: true; submission: Submission; metrics: VideoMetrics | null }
  | {
      ok: false;
      code:
        | 'NO_ACTIVE_CAMPAIGN'
        | 'CAMPAIGN_ENDED'
        | 'BAD_URL'
        | 'DUPLICATE'
        | 'HANDLE_TAKEN';
      /** Copy safe to post back into the chat. */
      message: string;
      /** Present for DUPLICATE, so the app can link to the original. */
      existing?: Submission;
    };

export type DecideResult =
  | { ok: true; submission: Submission }
  | { ok: false; code: string; message: string };

export interface CampaignServiceOptions {
  /** Injected for deterministic tests. */
  now?: () => number;
  /** Allow an admin to approve their own submission. Off by default. */
  allowSelfApproval?: boolean;
  /** Fetch implementation, passed through to short-link resolution. */
  fetchImpl?: typeof fetch;
}

export class CampaignService {
  private readonly now: () => number;

  constructor(
    private readonly repo: Repository,
    private readonly provider: ViewCountProvider,
    private readonly opts: CampaignServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // Handle claiming
  // -------------------------------------------------------------------------

  /**
   * Records the handle a user says is theirs.
   *
   * A handle can only belong to one user. Without that rule two accounts could
   * both claim the same creator and both pass the ownership check.
   */
  async claimHandle(input: {
    userId: string;
    platform: Platform;
    handle: string;
  }): Promise<{ ok: true } | { ok: false; code: 'HANDLE_TAKEN'; message: string }> {
    const handle = normalizeHandle(input.handle);
    const owner = await this.repo.getHandleOwner(input.platform, handle);

    if (owner && owner !== input.userId) {
      return {
        ok: false,
        code: 'HANDLE_TAKEN',
        message: `@${handle} is already linked to another member. If that's your account, ask an admin.`,
      };
    }

    await this.repo.claimHandle({
      userId: input.userId,
      platform: input.platform,
      handle,
      claimedAt: this.now(),
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  async submit(input: {
    chatId: string;
    userId: string;
    messageId?: string | null;
    url: string;
  }): Promise<SubmitResult> {
    const campaign = await this.repo.getActiveCampaignForChat(input.chatId);
    if (!campaign) {
      return {
        ok: false,
        code: 'NO_ACTIVE_CAMPAIGN',
        message: 'There is no active campaign in this chat right now.',
      };
    }

    const nowMs = this.now();
    if (campaign.endsAt !== null && nowMs / 1000 > campaign.endsAt) {
      return {
        ok: false,
        code: 'CAMPAIGN_ENDED',
        message: `The ${campaign.name} campaign has ended, so submissions are closed.`,
      };
    }

    const parsed = await this.parseUrl(input.url);
    if (!parsed.ok) {
      return { ok: false, code: 'BAD_URL', message: parsed.message };
    }
    const { value: url } = parsed;

    // Dedup before spending a provider credit.
    const existing = await this.repo.findSubmissionByVideo(
      campaign.id,
      url.platform,
      url.externalId,
    );
    if (existing) {
      const mine = existing.submitterUserId === input.userId;
      return {
        ok: false,
        code: 'DUPLICATE',
        message: mine
          ? 'You already submitted that video.'
          : 'That video has already been submitted by someone else.',
        existing,
      };
    }

    // Read metrics. A failure here does not block the submission — it becomes
    // a flag and the admin decides. Losing a real entry because a vendor had a
    // bad minute is worse than showing an admin a warning.
    let metrics: VideoMetrics | null = null;
    let fetchError: string | null = null;
    try {
      metrics = await this.provider.fetchMetrics(url);
    } catch (error) {
      fetchError =
        error instanceof ProviderError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
    }

    const claimed = await this.repo.getClaimedHandle(input.userId, url.platform);
    const flags: SubmissionFlag[] = evaluateFlags({
      metrics,
      claimedHandle: claimed?.handle ?? null,
      campaign,
      now: nowMs,
    });

    const submission: Submission = {
      id: newId('sub'),
      campaignId: campaign.id,
      chatId: input.chatId,
      messageId: input.messageId ?? null,
      submitterUserId: input.userId,
      platform: url.platform,
      originalUrl: input.url,
      canonicalUrl: url.canonicalUrl,
      externalId: url.externalId,
      status: 'pending',
      flags,
      authorHandle: metrics?.authorHandle ?? null,
      postedAt: metrics?.postedAt ?? null,
      caption: metrics?.caption ?? null,
      latestViews: metrics?.views ?? null,
      latestViewsAt: metrics ? metrics.fetchedAt : null,
      viewsAtApproval: null,
      fetchError,
      decidedByUserId: null,
      decidedAt: null,
      declineReason: null,
      createdAt: nowMs,
      updatedAt: nowMs,
    };

    await this.repo.insertSubmission(submission);

    if (metrics) {
      await this.repo.insertSnapshot({
        submissionId: submission.id,
        views: metrics.views,
        likes: metrics.likes,
        comments: metrics.comments,
        shares: metrics.shares,
        capturedAt: metrics.fetchedAt,
        source: metrics.source,
      });
    }

    await this.repo.recordEvent({
      submissionId: submission.id,
      event: metrics ? 'submitted' : 'fetch_failed',
      actorUserId: input.userId,
      fromStatus: null,
      toStatus: 'pending',
      detail: { flags, fetchError },
    });

    return { ok: true, submission, metrics };
  }

  private parseUrl(url: string) {
    return parseSubmittedUrl(url, this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {});
  }

  // -------------------------------------------------------------------------
  // Admin decisions
  // -------------------------------------------------------------------------

  async decide(input: {
    submissionId: string;
    actor: Actor;
    action: 'approve' | 'decline' | 'reopen';
    reason?: string | null;
  }): Promise<DecideResult> {
    const submission = await this.repo.getSubmission(input.submissionId);
    if (!submission) {
      return { ok: false, code: 'NOT_FOUND', message: 'That submission no longer exists.' };
    }

    const opts = {
      now: this.now(),
      allowSelfApproval: this.opts.allowSelfApproval ?? false,
    };

    const result =
      input.action === 'approve'
        ? approve(submission, input.actor, opts)
        : input.action === 'decline'
          ? decline(submission, input.actor, input.reason ?? null, opts)
          : reopen(submission, input.actor, opts);

    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message };
    }

    await this.repo.updateSubmission(result.value);
    await this.repo.recordEvent({
      submissionId: submission.id,
      event:
        input.action === 'approve' ? 'approved' : input.action === 'decline' ? 'declined' : 'reopened',
      actorUserId: input.actor.userId,
      fromStatus: result.previousStatus,
      toStatus: result.value.status,
      detail: input.reason ? { reason: input.reason } : null,
    });

    return { ok: true, submission: result.value };
  }

  // -------------------------------------------------------------------------
  // View refresh
  // -------------------------------------------------------------------------

  /**
   * Re-reads view counts for approved submissions and appends a snapshot.
   *
   * Only approved submissions are refreshed — pending ones get their number at
   * submit time and refreshed on demand, and declined ones are dead weight.
   * That keeps credit burn proportional to the campaign's real size.
   */
  async refreshDue(limit = 25): Promise<{ refreshed: number; failed: number }> {
    const due = await this.repo.findDueForRefresh(
      this.opts.now ? 0 : refreshIntervalSeconds(),
      limit,
    );

    let refreshed = 0;
    let failed = 0;
    for (const submission of due) {
      const result = await this.refreshOne(submission);
      if (result) refreshed++;
      else failed++;
    }
    return { refreshed, failed };
  }

  /** Refreshes one submission. Returns the new metrics, or null on failure. */
  async refreshOne(submission: Submission): Promise<VideoMetrics | null> {
    let metrics: VideoMetrics;
    try {
      metrics = await this.provider.fetchMetrics({
        platform: submission.platform,
        externalId: submission.externalId,
        canonicalUrl: submission.canonicalUrl,
        wasShortLink: false,
      });
    } catch (error) {
      const message =
        error instanceof ProviderError ? `${error.code}: ${error.message}` : String(error);
      await this.repo.updateSubmission({
        ...submission,
        fetchError: message,
        updatedAt: this.now(),
      });
      await this.repo.recordEvent({
        submissionId: submission.id,
        event: 'fetch_failed',
        actorUserId: null,
        fromStatus: submission.status,
        toStatus: submission.status,
        detail: { error: message },
      });
      return null;
    }

    await this.repo.insertSnapshot({
      submissionId: submission.id,
      views: metrics.views,
      likes: metrics.likes,
      comments: metrics.comments,
      shares: metrics.shares,
      capturedAt: metrics.fetchedAt,
      source: metrics.source,
    });

    await this.repo.updateSubmission({
      ...submission,
      latestViews: metrics.views,
      latestViewsAt: metrics.fetchedAt,
      fetchError: null,
      updatedAt: this.now(),
    });

    await this.repo.recordEvent({
      submissionId: submission.id,
      event: 'refreshed',
      actorUserId: null,
      fromStatus: submission.status,
      toStatus: submission.status,
      detail: { views: metrics.views },
    });

    return metrics;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async queue(campaignId: string, limit = 50): Promise<Submission[]> {
    return this.repo.listSubmissions({ campaignId, status: 'pending', limit });
  }

  async approvedLog(campaignId: string, limit = 200): Promise<Submission[]> {
    return this.repo.listSubmissions({ campaignId, status: 'approved', limit });
  }

  async userSubmissions(campaignId: string, userId: string): Promise<Submission[]> {
    return this.repo.listSubmissions({ campaignId, submitterUserId: userId, limit: 100 });
  }

  async leaderboard(campaignId: string, limit = 25): Promise<LeaderboardRow[]> {
    return this.repo.leaderboard(campaignId, limit);
  }

  async campaignForChat(chatId: string): Promise<Campaign | null> {
    return this.repo.getActiveCampaignForChat(chatId);
  }
}

function refreshIntervalSeconds(): number {
  const raw = process.env.REFRESH_MIN_INTERVAL_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : 21_600;
}
