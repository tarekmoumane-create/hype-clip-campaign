import type {
  Campaign,
  CreatorHandle,
  Platform,
  Submission,
  SubmissionStatus,
  ViewSnapshot,
} from '../types.js';

/**
 * Storage interface.
 *
 * Async on purpose. The reference implementation is synchronous SQLite, but
 * the app's real store will be Postgres over a pool, and an async interface
 * ports without touching a single caller.
 */

export interface LeaderboardRow {
  userId: string;
  approvedCount: number;
  /** Sum of views_at_approval across approved submissions. */
  totalViewsAtApproval: number;
  /** Sum of the most recent reading — grows after approval. */
  totalCurrentViews: number;
}

export interface ListSubmissionsQuery {
  campaignId: string;
  status?: SubmissionStatus;
  submitterUserId?: string;
  limit?: number;
  offset?: number;
}

export interface SubmissionEvent {
  submissionId: string;
  event: 'submitted' | 'approved' | 'declined' | 'reopened' | 'refreshed' | 'fetch_failed';
  actorUserId: string | null;
  fromStatus: SubmissionStatus | null;
  toStatus: SubmissionStatus | null;
  detail?: Record<string, unknown> | null;
}

export interface Repository {
  // Campaigns
  createCampaign(campaign: Campaign): Promise<Campaign>;
  getCampaign(id: string): Promise<Campaign | null>;
  /** The single active campaign for a chat, or null. */
  getActiveCampaignForChat(chatId: string): Promise<Campaign | null>;

  // Handles
  claimHandle(handle: CreatorHandle): Promise<void>;
  getClaimedHandle(userId: string, platform: Platform): Promise<CreatorHandle | null>;
  /** Who already claimed this handle, if anyone. Guards against handle theft. */
  getHandleOwner(platform: Platform, handle: string): Promise<string | null>;

  // Submissions
  insertSubmission(submission: Submission): Promise<Submission>;
  updateSubmission(submission: Submission): Promise<Submission>;
  getSubmission(id: string): Promise<Submission | null>;
  /** Dedup lookup. */
  findSubmissionByVideo(
    campaignId: string,
    platform: Platform,
    externalId: string,
  ): Promise<Submission | null>;
  listSubmissions(query: ListSubmissionsQuery): Promise<Submission[]>;
  countSubmissions(campaignId: string, status?: SubmissionStatus): Promise<number>;

  /**
   * Approved submissions whose newest reading is older than
   * `minIntervalSeconds`, oldest first. Drives the refresh job.
   */
  findDueForRefresh(minIntervalSeconds: number, limit: number): Promise<Submission[]>;

  // Snapshots
  insertSnapshot(snapshot: Omit<ViewSnapshot, 'id'>): Promise<ViewSnapshot>;
  listSnapshots(submissionId: string): Promise<ViewSnapshot[]>;

  // Reporting
  leaderboard(campaignId: string, limit?: number): Promise<LeaderboardRow[]>;

  // Audit
  recordEvent(event: SubmissionEvent): Promise<void>;

  close(): Promise<void>;
}
