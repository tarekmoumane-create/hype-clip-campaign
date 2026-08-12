# 07 — Anti-fraud

Implementation: [`src/domain/fraud.ts`](../src/domain/fraud.ts).

**Read this before launching if approvals map to money.**

## The threat

Someone submits a video they did not make — typically a clip that is already
viral — and collects whatever an approved submission is worth. This is the
obvious attack and it requires no technical skill.

## The mechanism: claimed handles

A member links their account once:

```
/handle tiktok @alice_makes
```

Stored in `creator_handles`, normalized to lowercase with no `@`. On every
submission we compare the video's actual author (from the platform API) against
that claim.

| Outcome | Flag |
|---|---|
| Author matches the claim | *(no flag)* |
| Author differs | `HANDLE_MISMATCH` — **warning** |
| No claim on this platform | `NO_CLAIMED_HANDLE` — info |

Two rules make the comparison meaningful:

**Handles are unique per platform.** Enforced by a unique index. Without it two
members both claim `@someviralcreator` and both pass. First claim wins; the
second is refused.

**No fuzzy matching.** `@nike` and `@nike_official` are different accounts.
Treating them as the same is precisely the hole someone would walk through. The
comparison is exact after normalization, and the tests assert that similar
handles do *not* match.

## Flags annotate; they do not auto-reject

This is a deliberate product decision, and the most important one in this
document.

A `HANDLE_MISMATCH` does not block a submission. It renders as a warning on the
admin's card, and the admin decides.

The reason: a machine cannot distinguish a genuine second account from a stolen
clip. Real, common, legitimate cases that would be auto-rejected:

- Someone posts from a brand account, not their personal one
- Someone changed their handle after claiming it
- Someone maintains separate accounts and submits from either
- Someone claimed the wrong handle by typo

Auto-rejecting these makes the campaign feel arbitrary and hostile, and the
member has no recourse. Showing an admin a clear warning costs one glance and
gets the right answer.

Auto-rejection is available if you want it — enforce `HANDLE_MISMATCH` at the
service layer. The tradeoff is stated so the choice is deliberate rather than
inherited.

## Other checks

| Flag | Catches |
|---|---|
| `POSTED_BEFORE_CAMPAIGN` | Old videos resubmitted as new campaign entries |
| `LOW_VIEWS` | Entries submitted seconds after posting, before any real reach |
| `METRICS_UNAVAILABLE` | Posts we could not read at all |

**Duplicate detection** is the one hard block. `(campaign_id, platform,
external_id)` is uniquely indexed, so the same video cannot be entered twice —
by the same person or by different people, in any URL format. Canonicalization
means a short link and a full link resolve to the same id. This is enforced in
the database, not just in application code, because two simultaneous
submissions will race past an application-level check.

## What this does not stop

Be clear-eyed about the residual risk.

**A second account.** Someone creates `@alice_makes_2`, claims it, posts a
stolen clip there, and submits. The handle matches, so no flag fires. Ownership
checking verifies *the submitter controls the account that posted*, not *the
submitter made the video*.

**Bought views.** View counts come from the platform. If the platform counts
them, we count them. Nothing here detects purchased engagement.

**Coordinated groups.** Several members submitting each other's clips from
matching claimed handles all pass.

**Reused content.** A video that is genuinely theirs but was made for another
campaign, or a year ago, only trips `POSTED_BEFORE_CAMPAIGN` if it predates the
start date.

## If real money is attached

Layer these on top — none require schema changes:

1. **Require a claimed handle to submit.** Turn `NO_CLAIMED_HANDLE` from a flag
   into a refusal. Costs one setup step per member and removes the easiest path.
2. **Verify handle ownership properly.** Have the member put a one-time code in
   their bio or a video caption, then read it back through the provider's
   profile endpoint. This is the real fix for the second-account problem and is
   maybe a day of work.
3. **Cap per-member payouts** per campaign. Bounds the damage from any single
   successful abuse.
4. **Hold a review window.** Pay out 48 hours after approval, so a clip that
   gets deleted or exposed as stolen can still be reversed.
5. **Watch for suspicious patterns.** Many submissions from accounts created
   recently, or clips whose view counts are wildly out of line with the
   account's usual performance. The snapshot history supports this analysis.

## Rate limiting

Not implemented here, and you need it. Every `/submit` costs an API credit
before any dedup check can help, because the URL must be parsed and looked up.

Suggested: **10 submissions per member per hour**, **50 per chat per hour**.
Reject over-limit attempts with an ephemeral message *before* calling the
provider. Without this, one person pasting links in a loop drains your credit
balance.

## Privacy note

`caption`, `author_handle`, and `posted_at` are stored for every submission.
That is public data from a public post, but it is still a record of a member's
social identity linked to their Hype account. Include it in your data-deletion
path: deleting a user should delete their `creator_handles` rows and either
anonymize or remove their submissions.
