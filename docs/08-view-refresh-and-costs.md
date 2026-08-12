# 08 — View refresh and costs

Implementation: [`src/jobs/refresh.ts`](../src/jobs/refresh.ts),
[`src/service/campaign.ts`](../src/service/campaign.ts).

## Why refresh at all

A view count read thirty seconds after posting is meaningless. Content campaigns
are judged on how videos perform over days. The refresh job re-reads approved
clips on a schedule and appends to `view_snapshots`, so growth is recorded as it
happens.

That history cannot be reconstructed later. If you do not write it down as it
happens, it is gone.

## What refreshes, and what does not

| Status | Refreshed on a schedule? |
|---|---|
| `approved` | Yes |
| `pending` | No — has its submit-time reading; admins can force one |
| `declined` | Never |

Only approved clips refresh. That keeps credit burn proportional to the
campaign's real size rather than to how many links people pasted.

## Cadence

Controlled by `REFRESH_MIN_INTERVAL_SECONDS`, default **21600 (6 hours)**.

The job wakes every 15 minutes, selects approved submissions whose newest
reading is older than that interval, oldest first, and refreshes up to
`batchSize` (default 25). Ticks never overlap — a slow provider would otherwise
stack requests and burn credits at double the intended rate.

6 hours is a deliberate middle. Hourly quadruples cost for detail nobody reads;
daily loses the shape of the first-day spike, which is when most short-form
video earns its views.

## Costs

**1 credit per uncached read.** Instagram calls pass `cache_max_age`, and a
cache hit costs 0 — so re-reading the same Instagram post inside the cache
window is free. TikTok has no equivalent, so every TikTok read is billed.

Rough daily cost for a campaign, refreshing every 6 hours (4 reads/day):

| Approved clips | Reads/day | Notes |
|---|---|---|
| 25 | 100 | Small campaign |
| 100 | 400 | |
| 200 | 800 | |
| 500 | 2,000 | Consider a 12h interval |

Plus one credit per submission at submit time, including submissions that get
declined — the read happens before the admin sees it.

**Budget before enabling the job.** Estimate: `(approved_clips × 4) +
(daily_submissions)` credits per day.

### Levers if it costs too much

1. **Lengthen the interval.** 12h halves the cost. 24h quarters it.
2. **Stop refreshing old clips.** A 30-day-old video is not moving. Add
   `AND created_at > NOW() - INTERVAL '30 days'` to the refresh query — probably
   the single best change for a long-running campaign.
3. **Back off on stable clips.** If views moved less than 1% since the last
   reading, double that clip's interval. Cheap to implement, big saving on the
   long tail.
4. **Raise the Instagram cache window.** `IG_CACHE_MAX_AGE=3d` makes most
   Instagram refreshes free at the cost of staleness.

## Monitoring

`onCredits` fires on every provider response with the remaining balance. The
reference implementation warns below 100. **Wire this to a real alert** — a
campaign that silently stops recording views because the balance hit zero is a
bad way to find out.

Also watch:

- **`fetch_error` rate.** A sudden rise usually means the vendor changed a
  response shape. The provider tests in `tests/provider.test.ts` are what tell
  you which field moved.
- **Refresh lag** — oldest `latest_views_at` among approved submissions. If it
  exceeds ~2× the interval, the job is not keeping up with the batch size.

## Failure handling

A failed refresh does **not** clear existing numbers. It records `fetch_error`,
writes a `fetch_failed` event, and leaves `latest_views` alone. A stale number
is more useful than no number.

Retries use bounded exponential backoff, but only for genuinely retryable
failures — timeouts, 429s, 5xx. A deleted post or a private account fails
immediately rather than wasting three calls and delaying the queue.

| Error | Retryable |
|---|---|
| `TIMEOUT`, `RATE_LIMITED`, `UPSTREAM` | Yes |
| `NOT_FOUND`, `PRIVATE_OR_RESTRICTED`, `NO_VIEW_METRIC` | No |
| `AUTH`, `INSUFFICIENT_CREDITS` | No — alert an operator |

## When a post disappears after approval

A creator deletes their video, or makes their account private, after it was
approved. Refresh starts returning `NOT_FOUND` or `PRIVATE_OR_RESTRICTED`.

The submission keeps its approval and its `views_at_approval`. That is
intentional: the clip *was* live and *did* earn those views when the decision
was made, and retroactively voiding it because the creator later cleaned up
their profile is unfair.

Surface it to admins — a repeatedly-failing approved submission is worth a look,
since deleting a clip right after approval is also what someone gaming the
system would do. The `fetch_error` field and the event history give you that
signal; decide the policy before it happens.

## Scaling notes

The reference job runs in-process on a single node. For production:

- Run it as a **scheduled worker**, not inside the API process.
- Use `SELECT ... FOR UPDATE SKIP LOCKED` (or your queue's equivalent) so
  multiple workers do not refresh the same submission and pay twice.
- The `submissions_refresh_order` partial index exists for exactly this query.
- Keep provider concurrency modest. Scrape Creators suggests staying under 500
  concurrent requests; you should be nowhere near that.
