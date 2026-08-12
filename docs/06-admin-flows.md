# 06 — Admin flows

Implementation: [`src/domain/submission.ts`](../src/domain/submission.ts),
[`src/service/campaign.ts`](../src/service/campaign.ts).

## Who is an admin

The reference server reads `ADMIN_USER_IDS` from the environment. **Replace
this.** Use the app's existing groupchat admin role — the person who already
administers the chat administers its campaign. No new permission concept.

Check the role server-side on every mutating call. The card's `actions` array is
a UI convenience, not a security boundary.

## State machine

```
              ┌─────────┐
              │ pending │◄──────────┐
              └────┬────┘           │
                   │                │ reopen (admin)
        ┌──────────┴──────────┐     │
        │                     │     │
   approve                 decline   │
        │                     │     │
        ▼                     ▼     │
   ┌──────────┐         ┌──────────┐│
   │ approved ├─────────┤ declined ├┘
   └──────────┘         └──────────┘
```

Every transition is a pure function that takes a submission and returns a new
one. The caller persists the result. That makes the rules testable without a
database and trivial to port into the app's stack.

### Guards

| Rule | Why |
|---|---|
| Only admins may decide | Obvious, but enforce server-side |
| Only `pending` may be approved or declined | Prevents double-decision races |
| An admin may not approve their own submission | Self-dealing when rewards attach |
| An admin **may** decline their own submission | Harms no one |
| Only a decided submission may be reopened | |

### What approval does

1. `status` → `approved`
2. `decided_by_user_id`, `decided_at` recorded
3. **`views_at_approval` frozen** to the current `latest_views`
4. `submission_events` row written

Step 3 is the one to get right. Later refreshes update `latest_views` and must
never touch `views_at_approval`. If payouts read a number that keeps moving,
your campaign's cost is unbounded and you cannot reconcile what you paid.

### Reopen exists because admins misclick

The alternative — delete and resubmit — loses the view history already
collected. Reopen clears the decision and returns the submission to the queue
with its snapshots intact. It writes an audit event, so a reopened-and-flipped
decision is visible rather than silent.

## Reviewing at volume

The chat card is the primary surface. It works well up to a few dozen
submissions. Past that, scrolling chat to find pending items is miserable.

Two escape hatches exist without any data-model change:

**`/queue`** renders up to 20 pending submissions as cards, on demand.

**`GET /campaigns/:id/submissions?status=pending`** is the endpoint a real
moderation dashboard would call. Building that dashboard is a UI project — the
API, permissions, and audit trail already support it.

If you expect hundreds of submissions per campaign, build the dashboard before
launch rather than after. The chat card does not degrade gracefully at that
volume.

## Bulk approval

Not implemented, deliberately. Bulk-approving a queue defeats the point of
having a human check whether each video is real and on-brand — and the flags
that would catch a stolen clip are exactly what gets skimmed past when the
interaction is "select all → approve".

If you add it: exclude anything carrying a `warning`-severity flag from bulk
selection, so the entries that most need human attention cannot be swept
through by accident.

## Audit trail

Every decision writes to `submission_events`:

| Field | |
|---|---|
| `event` | `submitted`, `approved`, `declined`, `reopened`, `refreshed`, `fetch_failed` |
| `actor_user_id` | null for system actions like refresh |
| `from_status` → `to_status` | |
| `detail` | JSON — decline reason, flags at submit time, error text |

Campaigns with rewards get disputed. "Why was mine declined and theirs
approved?" is answerable from this table and unanswerable without it.

Surface `decline_reason` to the submitter. An unexplained rejection in a group
chat reads as favouritism; a reason reads as a standard.

## Handle disputes

Handles are first-come-first-served and unique per platform. When a member says
"that's my account but someone else claimed it", there is no self-service fix —
by design, since a self-service fix is just handle theft with extra steps.

Give admins a way to clear a claim (`DELETE FROM creator_handles WHERE ...`)
and expect to use it occasionally. Log it.

## Campaign lifecycle

**Starting.** `POST /campaigns` with `chatId`, `name`, `startsAt`. Videos posted
before `startsAt` get flagged, not blocked — someone may have made a great clip
the day before you announced.

**Ending.** Set `endsAt`. Submissions after it are refused with a clear message.
Already-approved clips keep refreshing so you can see how the campaign performed
after it closed.

**Closing out.** Deactivate the campaign, export the CSV, stop the refresh job
for that campaign. History stays in the database; a new campaign in the same
chat starts clean.
