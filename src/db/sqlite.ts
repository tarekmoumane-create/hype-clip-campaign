import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Loaded through createRequire rather than a static import: bundlers that
// predate node:sqlite try to resolve it as a package on disk and fail. The
// type-only import above is erased at compile time, so types still hold.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import type {
  Campaign,
  CreatorHandle,
  Platform,
  Submission,
  SubmissionFlag,
  SubmissionStatus,
  ViewSnapshot,
} from '../types.js';
import type {
  LeaderboardRow,
  ListSubmissionsQuery,
  Repository,
  SubmissionEvent,
} from './repo.js';

/**
 * SQLite implementation of Repository, for the reference server.
 *
 * The production app should implement Repository against its own database
 * instead — see migrations/001_init.sql for the canonical schema. This exists
 * so the whole flow is runnable end to end with no infrastructure.
 *
 * Timestamps are stored as INTEGER unix milliseconds. Postgres uses
 * TIMESTAMPTZ; the mapping is the only place the two schemas differ.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS campaigns (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER,
  min_views   INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_one_active_per_chat
  ON campaigns (chat_id) WHERE active = 1;

CREATE TABLE IF NOT EXISTS creator_handles (
  user_id    TEXT    NOT NULL,
  platform   TEXT    NOT NULL,
  handle     TEXT    NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, platform)
);
CREATE UNIQUE INDEX IF NOT EXISTS creator_handles_unique_per_platform
  ON creator_handles (platform, handle);

CREATE TABLE IF NOT EXISTS submissions (
  id                 TEXT PRIMARY KEY,
  campaign_id        TEXT    NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  chat_id            TEXT    NOT NULL,
  message_id         TEXT,
  submitter_user_id  TEXT    NOT NULL,
  platform           TEXT    NOT NULL,
  original_url       TEXT    NOT NULL,
  canonical_url      TEXT    NOT NULL,
  external_id        TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'pending',
  flags              TEXT    NOT NULL DEFAULT '[]',
  author_handle      TEXT,
  posted_at          INTEGER,
  caption            TEXT,
  latest_views       INTEGER,
  latest_views_at    INTEGER,
  views_at_approval  INTEGER,
  fetch_error        TEXT,
  decided_by_user_id TEXT,
  decided_at         INTEGER,
  decline_reason     TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS submissions_unique_video_per_campaign
  ON submissions (campaign_id, platform, external_id);
CREATE INDEX IF NOT EXISTS submissions_queue
  ON submissions (campaign_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS submissions_by_user
  ON submissions (submitter_user_id, campaign_id);

CREATE TABLE IF NOT EXISTS view_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT    NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
  views         INTEGER NOT NULL,
  likes         INTEGER,
  comments      INTEGER,
  shares        INTEGER,
  captured_at   INTEGER NOT NULL,
  source        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS view_snapshots_by_submission
  ON view_snapshots (submission_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS submission_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT    NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
  event         TEXT    NOT NULL,
  actor_user_id TEXT,
  from_status   TEXT,
  to_status     TEXT,
  detail        TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS submission_events_by_submission
  ON submission_events (submission_id, created_at DESC);
`;

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : value === null || value === undefined ? null : Number(value);
}
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : value === null || value === undefined ? null : String(value);
}

function rowToSubmission(row: Row): Submission {
  let flags: SubmissionFlag[] = [];
  try {
    const parsed: unknown = JSON.parse(str(row.flags) || '[]');
    if (Array.isArray(parsed)) flags = parsed as SubmissionFlag[];
  } catch {
    flags = [];
  }

  return {
    id: str(row.id),
    campaignId: str(row.campaign_id),
    chatId: str(row.chat_id),
    messageId: strOrNull(row.message_id),
    submitterUserId: str(row.submitter_user_id),
    platform: str(row.platform) as Platform,
    originalUrl: str(row.original_url),
    canonicalUrl: str(row.canonical_url),
    externalId: str(row.external_id),
    status: str(row.status) as SubmissionStatus,
    flags,
    authorHandle: strOrNull(row.author_handle),
    postedAt: numOrNull(row.posted_at),
    caption: strOrNull(row.caption),
    latestViews: numOrNull(row.latest_views),
    latestViewsAt: numOrNull(row.latest_views_at),
    viewsAtApproval: numOrNull(row.views_at_approval),
    fetchError: strOrNull(row.fetch_error),
    decidedByUserId: strOrNull(row.decided_by_user_id),
    decidedAt: numOrNull(row.decided_at),
    declineReason: strOrNull(row.decline_reason),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToCampaign(row: Row): Campaign {
  return {
    id: str(row.id),
    chatId: str(row.chat_id),
    name: str(row.name),
    startsAt: Number(row.starts_at),
    endsAt: numOrNull(row.ends_at),
    minViews: Number(row.min_views ?? 0),
    active: Number(row.active) === 1,
  };
}

export class SqliteRepository implements Repository {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  async createCampaign(campaign: Campaign): Promise<Campaign> {
    this.db
      .prepare(
        `INSERT INTO campaigns (id, chat_id, name, starts_at, ends_at, min_views, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        campaign.id,
        campaign.chatId,
        campaign.name,
        campaign.startsAt,
        campaign.endsAt,
        campaign.minViews,
        campaign.active ? 1 : 0,
      );
    return campaign;
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    const row = this.db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToCampaign(row) : null;
  }

  async getActiveCampaignForChat(chatId: string): Promise<Campaign | null> {
    const row = this.db
      .prepare(`SELECT * FROM campaigns WHERE chat_id = ? AND active = 1`)
      .get(chatId) as Row | undefined;
    return row ? rowToCampaign(row) : null;
  }

  async claimHandle(handle: CreatorHandle): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO creator_handles (user_id, platform, handle, claimed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, platform) DO UPDATE SET handle = excluded.handle, claimed_at = excluded.claimed_at`,
      )
      .run(handle.userId, handle.platform, handle.handle, handle.claimedAt);
  }

  async getClaimedHandle(userId: string, platform: Platform): Promise<CreatorHandle | null> {
    const row = this.db
      .prepare(`SELECT * FROM creator_handles WHERE user_id = ? AND platform = ?`)
      .get(userId, platform) as Row | undefined;
    if (!row) return null;
    return {
      userId: str(row.user_id),
      platform: str(row.platform) as Platform,
      handle: str(row.handle),
      claimedAt: Number(row.claimed_at),
    };
  }

  async getHandleOwner(platform: Platform, handle: string): Promise<string | null> {
    const row = this.db
      .prepare(`SELECT user_id FROM creator_handles WHERE platform = ? AND handle = ?`)
      .get(platform, handle) as Row | undefined;
    return row ? str(row.user_id) : null;
  }

  async insertSubmission(submission: Submission): Promise<Submission> {
    this.db
      .prepare(
        `INSERT INTO submissions (
           id, campaign_id, chat_id, message_id, submitter_user_id, platform,
           original_url, canonical_url, external_id, status, flags,
           author_handle, posted_at, caption, latest_views, latest_views_at,
           views_at_approval, fetch_error, decided_by_user_id, decided_at,
           decline_reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        submission.id,
        submission.campaignId,
        submission.chatId,
        submission.messageId,
        submission.submitterUserId,
        submission.platform,
        submission.originalUrl,
        submission.canonicalUrl,
        submission.externalId,
        submission.status,
        JSON.stringify(submission.flags),
        submission.authorHandle,
        submission.postedAt,
        submission.caption,
        submission.latestViews,
        submission.latestViewsAt,
        submission.viewsAtApproval,
        submission.fetchError,
        submission.decidedByUserId,
        submission.decidedAt,
        submission.declineReason,
        submission.createdAt,
        submission.updatedAt,
      );
    return submission;
  }

  async updateSubmission(submission: Submission): Promise<Submission> {
    this.db
      .prepare(
        `UPDATE submissions SET
           message_id = ?, status = ?, flags = ?, author_handle = ?, posted_at = ?,
           caption = ?, latest_views = ?, latest_views_at = ?, views_at_approval = ?,
           fetch_error = ?, decided_by_user_id = ?, decided_at = ?, decline_reason = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        submission.messageId,
        submission.status,
        JSON.stringify(submission.flags),
        submission.authorHandle,
        submission.postedAt,
        submission.caption,
        submission.latestViews,
        submission.latestViewsAt,
        submission.viewsAtApproval,
        submission.fetchError,
        submission.decidedByUserId,
        submission.decidedAt,
        submission.declineReason,
        submission.updatedAt,
        submission.id,
      );
    return submission;
  }

  async getSubmission(id: string): Promise<Submission | null> {
    const row = this.db.prepare(`SELECT * FROM submissions WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToSubmission(row) : null;
  }

  async findSubmissionByVideo(
    campaignId: string,
    platform: Platform,
    externalId: string,
  ): Promise<Submission | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM submissions WHERE campaign_id = ? AND platform = ? AND external_id = ?`,
      )
      .get(campaignId, platform, externalId) as Row | undefined;
    return row ? rowToSubmission(row) : null;
  }

  async listSubmissions(query: ListSubmissionsQuery): Promise<Submission[]> {
    const clauses = ['campaign_id = ?'];
    const params: unknown[] = [query.campaignId];

    if (query.status) {
      clauses.push('status = ?');
      params.push(query.status);
    }
    if (query.submitterUserId) {
      clauses.push('submitter_user_id = ?');
      params.push(query.submitterUserId);
    }
    params.push(query.limit ?? 50, query.offset ?? 0);

    const rows = this.db
      .prepare(
        `SELECT * FROM submissions WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[])) as Row[];
    return rows.map(rowToSubmission);
  }

  async countSubmissions(campaignId: string, status?: SubmissionStatus): Promise<number> {
    const row = status
      ? (this.db
          .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE campaign_id = ? AND status = ?`)
          .get(campaignId, status) as Row)
      : (this.db
          .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE campaign_id = ?`)
          .get(campaignId) as Row);
    return Number(row?.n ?? 0);
  }

  async findDueForRefresh(minIntervalSeconds: number, limit: number): Promise<Submission[]> {
    const cutoff = Date.now() - minIntervalSeconds * 1000;
    const rows = this.db
      .prepare(
        `SELECT * FROM submissions
         WHERE status = 'approved'
           AND (latest_views_at IS NULL OR latest_views_at < ?)
         ORDER BY latest_views_at ASC NULLS FIRST
         LIMIT ?`,
      )
      .all(cutoff, limit) as Row[];
    return rows.map(rowToSubmission);
  }

  async insertSnapshot(snapshot: Omit<ViewSnapshot, 'id'>): Promise<ViewSnapshot> {
    const result = this.db
      .prepare(
        `INSERT INTO view_snapshots (submission_id, views, likes, comments, shares, captured_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.submissionId,
        snapshot.views,
        snapshot.likes,
        snapshot.comments,
        snapshot.shares,
        snapshot.capturedAt,
        snapshot.source,
      );
    return { ...snapshot, id: String(result.lastInsertRowid) };
  }

  async listSnapshots(submissionId: string): Promise<ViewSnapshot[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM view_snapshots WHERE submission_id = ? ORDER BY captured_at ASC`,
      )
      .all(submissionId) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      submissionId: str(row.submission_id),
      views: Number(row.views),
      likes: numOrNull(row.likes),
      comments: numOrNull(row.comments),
      shares: numOrNull(row.shares),
      capturedAt: Number(row.captured_at),
      source: str(row.source),
    }));
  }

  async leaderboard(campaignId: string, limit = 25): Promise<LeaderboardRow[]> {
    const rows = this.db
      .prepare(
        `SELECT submitter_user_id AS user_id,
                COUNT(*) AS approved_count,
                COALESCE(SUM(views_at_approval), 0) AS total_at_approval,
                COALESCE(SUM(COALESCE(latest_views, views_at_approval, 0)), 0) AS total_current
         FROM submissions
         WHERE campaign_id = ? AND status = 'approved'
         GROUP BY submitter_user_id
         ORDER BY total_current DESC
         LIMIT ?`,
      )
      .all(campaignId, limit) as Row[];
    return rows.map((row) => ({
      userId: str(row.user_id),
      approvedCount: Number(row.approved_count),
      totalViewsAtApproval: Number(row.total_at_approval),
      totalCurrentViews: Number(row.total_current),
    }));
  }

  async recordEvent(event: SubmissionEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO submission_events
           (submission_id, event, actor_user_id, from_status, to_status, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.submissionId,
        event.event,
        event.actorUserId,
        event.fromStatus,
        event.toStatus,
        event.detail ? JSON.stringify(event.detail) : null,
        Date.now(),
      );
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
