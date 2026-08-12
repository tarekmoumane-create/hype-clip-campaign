# 01 — Overview

## The problem

Hype is running a content campaign. Members make TikToks and Reels about the
app. Today there is no way to collect those videos, verify they are real, see
how they performed, or keep a record of which ones were accepted.

## What gets built

A campaign runs inside a single groupchat. Inside that chat:

- A member submits a video by posting `/submit <link>`.
- The system reads the video's public **view count** from TikTok or Instagram.
- The system checks the video was posted by an account that member has claimed.
- A **card** appears in the chat showing the clip, its views, and any concerns.
- **Admins** — and only admins — see Approve and Decline on that card.
- Approved clips are **logged** with their view count, and re-checked over time
  so the record reflects how the video actually performed.

## Scope

**In scope**

- TikTok and Instagram video links
- One active campaign per groupchat
- View, like, comment and share counts where the platform exposes them
- Admin approve / decline / reopen, with an audit trail
- Ownership verification via claimed handles
- Duplicate detection across the whole campaign
- Ongoing view refresh and history
- CSV export of the approved log

**Out of scope** (deliberately — raise these separately if wanted)

- Paying people. This system records what was approved and how it performed;
  it does not move money. The data model is built so payouts *can* be computed
  later — see `views_at_approval` in [02](02-data-model.md).
- YouTube, X, Twitch.
- Editing or hosting video. We store links and numbers, never media.
- Automatic approval. Every accepted clip passes through a human.

## Decisions already made

These were settled before implementation. Each one has a cost; they are written
down so the tradeoff is visible rather than rediscovered mid-build.

### View counts come from Scrape Creators

TikTok and Instagram do not hand out view counts for arbitrary public URLs.
The realistic options were:

| Option | Why not chosen |
|---|---|
| Official platform APIs | Every submitter must OAuth-connect their account, and Instagram additionally requires a Business or Creator account. Too much friction for a campaign that wants volume. |
| Scraping the pages ourselves | Fragile, breaks on layout changes, and sits badly with both platforms' terms. |
| **Scrape Creators (chosen)** | Works from a plain public URL with no submitter OAuth. Costs ~1 credit per read. |

The dependency is isolated behind one interface, `ViewCountProvider`
(`src/providers/types.ts`). If the vendor ever needs replacing, that interface
is the only thing that has to be reimplemented — nothing above it knows where
the numbers come from.

Verified live on 2026-08-12:

| Platform | Endpoint | View field |
|---|---|---|
| TikTok | `GET /v2/tiktok/video?url=` | `aweme_detail.statistics.play_count` |
| Instagram | `GET /v1/instagram/post?url=` | `data.xdt_shortcode_media.video_play_count` |

### Approval happens on a card in the chat

Rather than a separate moderation screen. The admin is already in the chat when
submissions arrive, and approving in place means no context switch and the group
sees outcomes as they happen.

The tradeoff: reviewing 200 submissions by scrolling chat is painful. The API
supports a queue view (`GET /campaigns/:id/submissions?status=pending`) and the
`/queue` command renders it, so a dashboard can be added later without changing
the data model. See [06](06-admin-flows.md).

### Ownership is verified by claimed handles, and flags do not auto-reject

A member links their TikTok/Instagram handle once with `/handle`. When they
submit, we compare the video's actual author against that claim.

A mismatch **flags** the submission — it does not reject it. A machine cannot
tell a genuine second account from a stolen viral clip, and silently rejecting
real entries damages a campaign more than showing an admin a warning does.
The admin stays the decision-maker. See [07](07-anti-fraud.md).

### Two view numbers are stored, not one

`views_at_approval` is frozen at the moment an admin approves. `latest_views`
keeps moving as the video grows. Payout math should read the first; leaderboards
can use either. Storing only one number makes the other unrecoverable.

### One campaign per chat at a time

Enforced by a partial unique index. It means `/submit` is never ambiguous about
which campaign an entry belongs to. A chat can run a second campaign later; the
first is marked inactive and its history stays intact.

## Non-goals worth stating

- **This is not a fraud-proof system.** A determined person with a second
  account can submit a clip they did not make. Ownership checking raises the
  effort required and gives admins a signal; it does not eliminate the problem.
  If real money is attached, read [07](07-anti-fraud.md) before launch.
- **View counts are point-in-time readings**, not a live feed. A number on a
  card is as fresh as the last refresh, and the card says when that was.

## Reading order

Build order matters less than understanding order:

1. [02 — Data model](02-data-model.md) — everything else assumes these tables.
2. [03 — Submitter experience](03-submitter-experience.md) — what members see.
3. [05 — Chat card spec](05-chat-card-spec.md) — what admins see.
4. [04 — API contracts](04-api-contracts.md) — the wire format.
5. [09 — Edge cases](09-edge-cases.md) — read before estimating.
