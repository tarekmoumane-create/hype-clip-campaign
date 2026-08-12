-- Clip campaign schema (PostgreSQL).
--
-- This is the canonical data model. The reference server in src/ runs the same
-- shape on SQLite; if the two ever disagree, this file wins.
--
-- Naming assumes you already have `users` and `chats` tables. Adjust the
-- foreign keys to match your real table names before running.

BEGIN;

-- ---------------------------------------------------------------------------
-- campaigns
-- One campaign per groupchat run. Keeping this separate from the chat means a
-- chat can run a second campaign later without its history bleeding through.
-- ---------------------------------------------------------------------------
CREATE TABLE campaigns (
    id              TEXT PRIMARY KEY,
    chat_id         TEXT        NOT NULL,
    name            TEXT        NOT NULL,
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ,
    -- Submissions below this view count get a LOW_VIEWS flag. 0 disables.
    min_views       INTEGER     NOT NULL DEFAULT 0,
    active          BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active campaign per chat, so `/submit` is never ambiguous.
CREATE UNIQUE INDEX campaigns_one_active_per_chat
    ON campaigns (chat_id)
    WHERE active;

-- ---------------------------------------------------------------------------
-- creator_handles
-- A user's claimed TikTok / Instagram handle. Used to check that a submitted
-- video was actually posted by the person submitting it.
-- ---------------------------------------------------------------------------
CREATE TABLE creator_handles (
    user_id     TEXT        NOT NULL,
    platform    TEXT        NOT NULL CHECK (platform IN ('tiktok', 'instagram')),
    -- Always stored lowercased with no leading '@'.
    handle      TEXT        NOT NULL,
    claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, platform)
);

-- A given handle may only be claimed by one user. Without this, two accounts
-- can both claim @someviralcreator and both pass the ownership check.
CREATE UNIQUE INDEX creator_handles_unique_per_platform
    ON creator_handles (platform, handle);

-- ---------------------------------------------------------------------------
-- submissions
-- ---------------------------------------------------------------------------
CREATE TABLE submissions (
    id                  TEXT PRIMARY KEY,
    campaign_id         TEXT        NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
    chat_id             TEXT        NOT NULL,
    -- Chat message carrying the command, so the client can attach the card.
    message_id          TEXT,
    submitter_user_id   TEXT        NOT NULL,

    platform            TEXT        NOT NULL CHECK (platform IN ('tiktok', 'instagram')),
    -- Exactly what the user pasted, kept for support and dispute resolution.
    original_url        TEXT        NOT NULL,
    -- Tracking params stripped. This is what we display and re-fetch.
    canonical_url       TEXT        NOT NULL,
    -- TikTok aweme id, or Instagram shortcode. Basis for dedup.
    external_id         TEXT        NOT NULL,

    status              TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'approved', 'declined')),
    -- SubmissionFlag[] as reported at submit time.
    flags               JSONB       NOT NULL DEFAULT '[]'::jsonb,

    author_handle       TEXT,
    posted_at           TIMESTAMPTZ,
    caption             TEXT,

    -- Denormalized copy of the newest snapshot, so listing the queue does not
    -- need a correlated subquery against view_snapshots.
    latest_views        BIGINT,
    latest_views_at     TIMESTAMPTZ,

    -- Views frozen at the moment of approval. Payout math reads THIS, never
    -- latest_views, so a number cannot move after the decision was made.
    views_at_approval   BIGINT,

    fetch_error         TEXT,

    decided_by_user_id  TEXT,
    decided_at          TIMESTAMPTZ,
    decline_reason      TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- A decision must record who made it.
    CONSTRAINT submissions_decision_is_attributed
        CHECK ((status = 'pending') = (decided_at IS NULL)
               AND (decided_at IS NULL) = (decided_by_user_id IS NULL))
);

-- The dedup rule: one campaign cannot contain the same video twice, no matter
-- who submits it or which URL format they use.
CREATE UNIQUE INDEX submissions_unique_video_per_campaign
    ON submissions (campaign_id, platform, external_id);

CREATE INDEX submissions_queue
    ON submissions (campaign_id, status, created_at DESC);

CREATE INDEX submissions_by_user
    ON submissions (submitter_user_id, campaign_id);

-- Drives the refresh job: approved rows, oldest reading first.
CREATE INDEX submissions_refresh_order
    ON submissions (status, latest_views_at NULLS FIRST)
    WHERE status = 'approved';

-- ---------------------------------------------------------------------------
-- view_snapshots
-- Append-only history. Never updated, never deleted. Growth over time is the
-- whole point of a content campaign, and you cannot reconstruct it later.
-- ---------------------------------------------------------------------------
CREATE TABLE view_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    submission_id   TEXT        NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
    views           BIGINT      NOT NULL,
    likes           BIGINT,
    comments        BIGINT,
    shares          BIGINT,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Which provider produced this reading.
    source          TEXT        NOT NULL
);

CREATE INDEX view_snapshots_by_submission
    ON view_snapshots (submission_id, captured_at DESC);

-- ---------------------------------------------------------------------------
-- submission_events
-- Audit trail. Who did what, when. Campaigns involving rewards get disputed;
-- without this you have nothing to point at.
-- ---------------------------------------------------------------------------
CREATE TABLE submission_events (
    id              BIGSERIAL PRIMARY KEY,
    submission_id   TEXT        NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
    -- 'submitted' | 'approved' | 'declined' | 'reopened' | 'refreshed' | 'fetch_failed'
    event           TEXT        NOT NULL,
    actor_user_id   TEXT,
    from_status     TEXT,
    to_status       TEXT,
    detail          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX submission_events_by_submission
    ON submission_events (submission_id, created_at DESC);

COMMIT;
