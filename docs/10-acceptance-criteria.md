# 10 — Acceptance criteria

A testable definition of done. Each item is observable behaviour, not
implementation detail.

## Submission

- [ ] `/submit <tiktok-link>` in a chat with an active campaign creates a
      pending submission and posts a card to the chat
- [ ] `/submit <instagram-reel-link>` does the same
- [ ] Aliases `/clip`, `/sub`, `/post`, `/entry` all work
- [ ] The verb is case-insensitive
- [ ] Extra words around the link are tolerated
- [ ] A `vm.tiktok.com` short link resolves and stores the canonical URL
- [ ] Tracking params (`?is_from_webapp`, `?igsh`) are stripped before storage
- [ ] A link with no scheme is accepted
- [ ] A YouTube link is refused with platform-specific copy
- [ ] A profile URL is refused with copy distinguishing it from a video URL
- [ ] `tiktok.com.evil.com` is refused
- [ ] A bare link with no command does nothing (default config)
- [ ] `/mute` and other non-campaign slash commands are unaffected
- [ ] All submission errors are ephemeral, visible only to the sender

## View counts

- [ ] A submitted TikTok video shows its real play count
- [ ] A submitted Instagram reel shows its real play count
- [ ] Instagram prefers `video_play_count` over `video_view_count`
- [ ] An Instagram photo post is refused with "not a video" copy
- [ ] A private post records the submission with `METRICS_UNAVAILABLE`
- [ ] A provider timeout retries, then records the submission with the flag
- [ ] A failed read never discards the submission
- [ ] Unavailable views render as `—`, never as `0`
- [ ] Every card shows when its view count was read

## Duplicates

- [ ] The same video submitted twice by the same member is refused
- [ ] The same video submitted by a different member is refused, naming the
      original
- [ ] The same video submitted as a short link and a full link is caught
- [ ] Two simultaneous submissions of the same video result in exactly one row
- [ ] The same video may be submitted in a different campaign

## Handles

- [ ] `/handle tiktok @name` links an account
- [ ] Aliases `tt`, `ig`, `insta` work; order does not matter
- [ ] A pasted profile URL infers the platform
- [ ] Handles are stored lowercased with no `@`
- [ ] A second member claiming the same handle is refused
- [ ] A member re-claiming their own handle succeeds
- [ ] The same handle on different platforms may belong to different members
- [ ] `/handle tiktok @not a handle!` is refused

## Flags

- [ ] Author matching the claimed handle produces no flags
- [ ] Author differing produces `HANDLE_MISMATCH` at warning severity
- [ ] No claimed handle produces `NO_CLAIMED_HANDLE` at info severity
- [ ] `@nike` and `@nike_official` do **not** match
- [ ] A video posted before `starts_at` produces `POSTED_BEFORE_CAMPAIGN`
- [ ] Views below `min_views` produce `LOW_VIEWS`
- [ ] `min_views = 0` disables that check
- [ ] Flags never prevent approval

## Admin decisions

- [ ] An admin sees Approve and Decline on a pending card
- [ ] A non-admin sees no action buttons
- [ ] A non-admin calling the decision endpoint gets 403
- [ ] Approving sets status, decider, timestamp, and freezes
      `views_at_approval`
- [ ] Declining with a reason stores and displays the reason
- [ ] Approving an already-decided submission returns 409
- [ ] An admin cannot approve their own submission
- [ ] An admin **can** decline their own submission
- [ ] Reopen returns a decided submission to pending and clears the decision
- [ ] Reopen preserves the view history
- [ ] Every decision writes a `submission_events` row
- [ ] Deciding updates the existing card in place, not as a new message

## Refresh

- [ ] Approved submissions refresh on schedule
- [ ] Pending and declined submissions do not refresh on schedule
- [ ] Each refresh appends a `view_snapshots` row
- [ ] Refresh updates `latest_views`
- [ ] Refresh **never** changes `views_at_approval`
- [ ] A failed refresh keeps the previous numbers and records `fetch_error`
- [ ] Retryable errors retry with backoff; permanent errors do not
- [ ] Overlapping ticks cannot run concurrently
- [ ] Credit balance is monitored and alerts when low

## Logging and export

- [ ] `GET /campaigns/:id/export.csv` returns approved submissions
- [ ] The CSV includes both `views_at_approval` and `current_views`
- [ ] Values beginning `=`, `+`, `-`, `@` are neutralized against formula
      injection
- [ ] Values containing commas or quotes are correctly escaped
- [ ] Export is admin-only

## Leaderboard

- [ ] Ranks members by total current views across approved submissions
- [ ] Pending submissions do not count
- [ ] Declined submissions do not count
- [ ] Handles a member with no display name without breaking

## Security

- [ ] Admin status is checked server-side on every mutating endpoint
- [ ] The card's `actions` array is built server-side per viewer
- [ ] A patched client cannot approve by calling the endpoint directly
- [ ] Internal errors, vendor names, and HTTP statuses never reach members
- [ ] The API key is never logged and never sent to a client
- [ ] Rate limiting is in place for `/submit`

## Non-functional

- [ ] Submission feels immediate — provider call under ~3s or handled async
- [ ] The queue endpoint paginates
- [ ] Deleting a user removes their `creator_handles` and handles their
      submissions per your retention policy
- [ ] Refresh runs as a scheduled worker, not in the API process
- [ ] Multiple refresh workers cannot double-charge for the same submission

## Pre-launch

- [ ] Credit budget estimated against expected clip count
      ([08](08-view-refresh-and-costs.md))
- [ ] Low-credit alerting wired to a real channel
- [ ] `fetch_error` rate monitored
- [ ] Decision made on whether `NO_CLAIMED_HANDLE` blocks submission
      ([07](07-anti-fraud.md))
- [ ] Decision made on payout basis: `views_at_approval` or `current_views`
- [ ] Policy decided for posts deleted after approval
- [ ] Moderation dashboard built if hundreds of submissions are expected
- [ ] **API key rotated** if it was ever shared in a chat or transcript
