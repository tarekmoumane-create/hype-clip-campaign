# 09 — Edge cases

Read before estimating. Most of the work in this feature is here, not in the
happy path.

## URLs

| Case | Behaviour |
|---|---|
| Short link (`vm.tiktok.com`, `vt.`, `/t/`, `instagr.am`) | Resolved over the network before anything else, so dedup sees the real video |
| Short link will not resolve | Refused with "paste the full link instead" |
| Tracking params (`?is_from_webapp`, `?igsh`, `utm_*`) | Stripped before storage |
| Same video, two URL formats | One `external_id`, caught as a duplicate |
| Profile URL instead of a video | Refused with specific copy |
| No scheme (`tiktok.com/@u/video/1`) | Accepted, `https://` assumed |
| Lookalike domain (`tiktok.com.evil.com`) | Refused — host matching is exact, never `endsWith` |
| `javascript:` or `data:` URL | Refused |
| TikTok photo post | Accepted by the parser; the API then reports no play count |
| Instagram carousel or image post | Parsed, then refused with `NO_VIEW_METRIC` |
| Trailing punctuation from a paste | Trimmed |

Instagram shortcodes are **case-sensitive**. Do not lowercase them. TikTok
handles are case-insensitive and are lowercased for comparison.

## Duplicates

Checked twice, on purpose.

1. **Application check** before calling the provider — gives a friendly message
   and avoids spending a credit.
2. **Unique index** `(campaign_id, platform, external_id)` — the actual
   guarantee.

Two members submitting the same clip within milliseconds will both pass step 1.
Catch the constraint violation from the insert and convert it into the same
"already submitted" message. Do not let it surface as a 500.

Duplicates are scoped to the campaign, so the same video may legitimately be
entered in a later campaign in the same chat.

## Provider failures

| Situation | What happens |
|---|---|
| Post is private | Submission recorded, `METRICS_UNAVAILABLE`, admin decides |
| Post deleted between posting and submitting | Same |
| Age-restricted (403) | Same |
| Provider times out | Retried with backoff, then recorded with the flag |
| Provider returns 200 with `success: false` | Treated as a failure |
| Provider returns non-JSON | `MALFORMED_RESPONSE`, logged, flagged |
| Out of credits (402) | Not retried. **Alert an operator** |
| API key revoked (401) | Not retried. **Alert an operator** |

**A failed read never loses the submission.** It lands as pending with a flag.
Losing a real entry because a vendor had a bad minute is worse than showing an
admin a warning.

## Concurrency

**Two admins approve the same card.** First wins. Second gets `409
ALREADY_DECIDED`. The client should refresh the card rather than show an error —
the outcome the admin wanted did happen. This is normal, not exceptional; two
admins watching a chat will tap the same card.

**Approve and decline at the same instant.** Same mechanism — whichever lands
first wins, the other gets 409.

**Refresh during a decision.** Independent columns: refresh writes
`latest_views`, approval writes `views_at_approval` and `status`. A read-modify-
write of the whole row will clobber one of them. Update only the columns you
own, or use optimistic locking on `updated_at`.

**Two workers refreshing the same submission.** Wasted credits and a duplicate
snapshot. Use `SELECT ... FOR UPDATE SKIP LOCKED`.

## Timing

**Video posted before the campaign started.** Flagged, not blocked. Someone may
have made a great clip the day before you announced.

**Submitted seconds after posting.** Views will be near zero. `LOW_VIEWS` fires
if `min_views` is set. The refresh job picks it up later — but only if it gets
approved, so an admin approving early entries is what makes them trackable.

**Campaign ends while a submission is in flight.** Checked at submit time. A
few seconds of slop either way does not matter; do not add clock-skew handling.

**Post deleted after approval.** Approval and `views_at_approval` stand. See
[08](08-view-refresh-and-costs.md#when-a-post-disappears-after-approval).

## Handles

| Case | Behaviour |
|---|---|
| Two members claim the same handle | Second refused, `HANDLE_TAKEN` |
| Member re-claims their own handle | Allowed, no-op |
| Same handle on TikTok and Instagram, different members | Allowed — handles are per-platform |
| Member changes their handle on the platform | Old claim now mismatches; they re-run `/handle` |
| `/handle tiktok @not a handle!` | Refused — a handle cannot contain spaces |
| Handle with dots/underscores | Valid on both platforms |

Members who never claim a handle can still submit; they get
`NO_CLAIMED_HANDLE`. Whether that is acceptable is a campaign policy decision —
see [07](07-anti-fraud.md).

## Chat

**Message deleted after the card was posted.** The submission stands; the card
is gone. Store `message_id` so you can detect this. `/queue` remains the way
back to it.

**Card update arrives after the message was deleted.** Drop it silently.

**Member leaves the chat.** Their submissions stay. The leaderboard should
handle a missing display name without breaking.

**Campaign runs in a chat that gets deleted.** `ON DELETE CASCADE` from
campaigns to submissions handles the campaign row; decide separately whether
deleting a chat should delete its campaign at all — you probably want the
history.

## Numbers

**Views go down.** Real, and common. Platforms deduplicate views after the fact
and remove bot traffic. Store what the provider says. Do not clamp to a
monotonic maximum — you would be hiding a real correction.

**Views unavailable vs zero.** `null` and `0` are different. `null` renders as
`—`. A brand-new video legitimately has `0`. Never coalesce one into the other.

**Very large numbers.** Use `BIGINT`. A viral clip exceeding 2³¹ views is
unlikely but the column costs nothing.

**Instagram plays vs views.** Two different numbers; plays is larger and is what
the campaign scores on. The adapter prefers `video_play_count` and falls back to
`video_view_count` only when plays are absent. A silent fallback to the smaller
number would quietly understate every entry.

## Scale

**Hundreds of submissions.** The chat card stops being a usable review surface
somewhere around a few dozen. Build the dashboard before launch if you expect
this volume — the API already supports it.

**One member submitting in a loop.** Add rate limiting. Every submit costs a
credit before dedup can help. Suggested limits in
[07](07-anti-fraud.md#rate-limiting).

**Long captions.** Truncated to 120 characters for the card; stored in full.

**Emoji and RTL text in captions.** Truncation is by JavaScript string length,
which can split an emoji or a combining sequence. If that shows up in practice,
truncate by grapheme cluster with `Intl.Segmenter`.
