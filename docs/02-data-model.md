# 02 — Data model

Canonical DDL: [`migrations/001_init.sql`](../migrations/001_init.sql).
TypeScript mirror: [`src/types.ts`](../src/types.ts). If they disagree, the SQL
wins.

## Tables at a glance

```
campaigns ──┬── submissions ──┬── view_snapshots
            │                 └── submission_events
            └── (chat_id)

creator_handles   (user_id, platform) → claimed handle
```

## campaigns

One campaign per groupchat run.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `chat_id` | TEXT | The groupchat this runs in |
| `name` | TEXT | Shown on the leaderboard |
| `starts_at` | TIMESTAMPTZ | Videos posted before this get flagged |
| `ends_at` | TIMESTAMPTZ NULL | NULL = open-ended. Submissions refused after |
| `min_views` | INTEGER | Below this → `LOW_VIEWS` flag. 0 disables |
| `active` | BOOLEAN | |

```sql
CREATE UNIQUE INDEX campaigns_one_active_per_chat
    ON campaigns (chat_id) WHERE active;
```

That partial index is what makes `/submit` unambiguous — there is never a
question of which campaign an entry belongs to. A chat can run a second campaign
later by deactivating the first; history is preserved.

## creator_handles

What each member says their social accounts are.

| Column | Type | Notes |
|---|---|---|
| `user_id` | TEXT | |
| `platform` | TEXT | `tiktok` \| `instagram` |
| `handle` | TEXT | Always lowercased, no leading `@` |
| `claimed_at` | TIMESTAMPTZ | |

Primary key `(user_id, platform)` — one handle per person per platform.

```sql
CREATE UNIQUE INDEX creator_handles_unique_per_platform
    ON creator_handles (platform, handle);
```

**This second index is the one that matters.** Without it, two members can both
claim `@someviralcreator` and both pass the ownership check. With it, the handle
belongs to whoever claimed it first and the second attempt is refused.

Normalize on write, always. `@Alice_Makes`, `alice_makes`, and ` @alice_makes `
must all store as `alice_makes` or the comparison silently fails.

## submissions

The core table.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `campaign_id` | TEXT FK | |
| `chat_id` | TEXT | Denormalized for cheap chat-scoped queries |
| `message_id` | TEXT NULL | The chat message carrying the command, so the client can attach the card |
| `submitter_user_id` | TEXT | |
| `platform` | TEXT | `tiktok` \| `instagram` |
| `original_url` | TEXT | Exactly what the user pasted. Kept for disputes |
| `canonical_url` | TEXT | Tracking params stripped. What we display and re-fetch |
| `external_id` | TEXT | TikTok aweme id, or Instagram shortcode |
| `status` | TEXT | `pending` \| `approved` \| `declined` |
| `flags` | JSONB | Machine-detected concerns, as reported at submit time |
| `author_handle` | TEXT NULL | Who actually posted it, per the platform |
| `posted_at` | TIMESTAMPTZ NULL | When the video went up |
| `caption` | TEXT NULL | |
| `latest_views` | BIGINT NULL | Newest reading. Moves over time |
| `latest_views_at` | TIMESTAMPTZ NULL | When that reading was taken |
| `views_at_approval` | BIGINT NULL | **Frozen at approval. Never updated** |
| `fetch_error` | TEXT NULL | Set when the provider call failed |
| `decided_by_user_id` | TEXT NULL | |
| `decided_at` | TIMESTAMPTZ NULL | |
| `decline_reason` | TEXT NULL | |

### The two view columns

This is the single most important thing in the schema.

- **`views_at_approval`** — what the clip had when the admin said yes. Fixed
  forever. Payout math reads this. It is auditable: you can always show a
  creator the exact number their reward was based on.
- **`latest_views`** — what it has now. Grows. Good for leaderboards and for
  showing a campaign's real reach.

Storing only one makes the other unrecoverable. A campaign that pays on
`latest_views` has a bill that changes after the fact; a campaign that only
keeps `views_at_approval` cannot show that its clips kept growing.

### Constraints

```sql
CONSTRAINT submissions_decision_is_attributed
    CHECK ((status = 'pending') = (decided_at IS NULL)
           AND (decided_at IS NULL) = (decided_by_user_id IS NULL))
```

A decided submission must record who decided it and when. This catches the
class of bug where a status is updated by a path that forgets the attribution —
which is exactly the record you need when a decision is disputed.

### Indexes

```sql
-- Dedup: one campaign cannot contain the same video twice, whoever submits it.
CREATE UNIQUE INDEX submissions_unique_video_per_campaign
    ON submissions (campaign_id, platform, external_id);

CREATE INDEX submissions_queue        ON submissions (campaign_id, status, created_at DESC);
CREATE INDEX submissions_by_user      ON submissions (submitter_user_id, campaign_id);
CREATE INDEX submissions_refresh_order ON submissions (status, latest_views_at NULLS FIRST)
    WHERE status = 'approved';
```

The unique index is a correctness guarantee, not an optimization. Application
code checks for duplicates first to give a friendly message, but two members
submitting the same clip simultaneously will race past that check — the index
is what actually prevents the double entry. Handle the constraint violation and
convert it into the same friendly message. See [09](09-edge-cases.md).

## view_snapshots

Append-only history. Never updated, never deleted.

| Column | Type |
|---|---|
| `id` | BIGSERIAL PK |
| `submission_id` | TEXT FK |
| `views`, `likes`, `comments`, `shares` | BIGINT (nullable except views) |
| `captured_at` | TIMESTAMPTZ |
| `source` | TEXT — which provider produced this reading |

One row per reading: one at submit time, then one per refresh. Growth over
time is most of what a content campaign wants to know, and it cannot be
reconstructed after the fact — if you do not write it down as it happens, it is
gone.

`source` is there so that if you ever switch providers, or a vendor's numbers
shift, you can tell which readings came from where.

## submission_events

Audit trail: who did what, when.

| Column | Type |
|---|---|
| `id` | BIGSERIAL PK |
| `submission_id` | TEXT FK |
| `event` | `submitted` \| `approved` \| `declined` \| `reopened` \| `refreshed` \| `fetch_failed` |
| `actor_user_id` | TEXT NULL — null for system actions |
| `from_status`, `to_status` | TEXT NULL |
| `detail` | JSONB |
| `created_at` | TIMESTAMPTZ |

Campaigns with rewards attached get disputed. Without this table you have a
current state and no way to explain how it got there.

## Flags

Stored on `submissions.flags` as a JSON array of strings.

| Flag | Meaning | Severity |
|---|---|---|
| `HANDLE_MISMATCH` | Video's author ≠ the handle this member claimed | warning |
| `NO_CLAIMED_HANDLE` | Member never linked a handle on this platform | info |
| `POSTED_BEFORE_CAMPAIGN` | Video predates `campaign.starts_at` | warning |
| `METRICS_UNAVAILABLE` | View count could not be read | info |
| `LOW_VIEWS` | Below `campaign.min_views` | info |

Flags annotate; they never auto-reject. See [07](07-anti-fraud.md) for why.

## Timestamp conventions

- Postgres: `TIMESTAMPTZ`.
- The reference SQLite store uses INTEGER unix **milliseconds**, except
  `posted_at`, which is unix **seconds** because that is what both platform APIs
  return. This mismatch is a real trap — normalize at the provider boundary if
  you would rather not carry it.
