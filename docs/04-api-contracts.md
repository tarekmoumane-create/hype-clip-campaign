# 04 — API contracts

Reference implementation: [`src/server.ts`](../src/server.ts).

The reference server authenticates with an `X-User-Id` header and reads admin
status from an env var. **Both are scaffolding.** The real implementation must
use the app's existing session auth and the existing groupchat admin role.

Every endpoint below is scoped to a campaign or a submission, and every mutating
endpoint re-checks permission server-side. Never trust a client's claim that its
user is an admin.

---

## POST /chat/messages

The main integration point. The app's message pipeline calls this for every
group message; anything that is not a campaign command returns an empty array
and falls through untouched.

**Request**

```json
{
  "chatId": "chat_abc",
  "text": "/submit https://www.tiktok.com/@alice/video/123",
  "messageId": "msg_xyz",
  "displayName": "@alice"
}
```

**Response** — a list of things for the client to do.

```json
{
  "responses": [
    { "type": "card", "card": { "...": "see 05-chat-card-spec.md" } }
  ]
}
```

Response types:

| `type` | Meaning |
|---|---|
| `text` | Post a message visible to the whole chat |
| `ephemeral` | Show only to `toUserId`. Used for every error |
| `card` | Render a new submission card in the chat |
| `card_update` | Replace an existing card in place, after a decision |

An empty `responses` array means the message was not a campaign command. Do
nothing.

---

## POST /submissions/:id/decision

Approve, decline, or reopen. **Admin only.**

**Request**

```json
{ "action": "approve" }
{ "action": "decline", "reason": "not on brand" }
{ "action": "reopen" }
```

**Response 200**

```json
{
  "submission": { "status": "approved", "viewsAtApproval": 12431, "...": "" },
  "card": { "...": "updated card, ready to render" }
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 403 | `NOT_ADMIN` | Caller is not a campaign admin |
| 404 | `NOT_FOUND` | No such submission |
| 409 | `ALREADY_DECIDED` | Someone already decided it |
| 409 | `SELF_APPROVAL` | Admin tried to approve their own submission |
| 409 | `NOT_DECIDED` | Reopen called on a pending submission |

`ALREADY_DECIDED` is the important one. Two admins tapping Approve on the same
card is normal, not exceptional. The second request must fail cleanly and the
client should refresh the card rather than showing an error — see
[09](09-edge-cases.md).

---

## GET /campaigns/:campaignId/submissions

The review queue.

**Query:** `status=pending|approved|declined`, `limit` (default 50), `offset`.

**Response**

```json
{
  "submissions": [ { "...": "raw records" } ],
  "cards":       [ { "...": "rendered for the calling viewer" } ]
}
```

`cards` are built for **the caller**. A non-admin gets the same submissions with
an empty `actions` array. This is why the card is built server-side: the client
never decides who may act.

---

## GET /submissions/:id

One submission, its card, and its full view history.

```json
{
  "submission": { "...": "" },
  "card": { "...": "" },
  "snapshots": [
    { "views": 12431, "capturedAt": 1760000000000, "source": "scrapecreators" },
    { "views": 250000, "capturedAt": 1760021600000, "source": "scrapecreators" }
  ]
}
```

`snapshots` is what a growth chart renders from.

---

## POST /submissions/:id/refresh

Forces an immediate re-read. Costs one API credit. Intended for an admin
pull-to-refresh, not for polling.

Returns `502` if the provider could not be reached; the submission keeps its
previous numbers and records `fetch_error`.

---

## GET /campaigns/:campaignId/leaderboard

```json
{
  "rows": [
    { "userId": "user_b", "approvedCount": 3,
      "totalViewsAtApproval": 45000, "totalCurrentViews": 91000 }
  ]
}
```

Approved submissions only. Pending and declined never count.

---

## GET /campaigns/:campaignId/export.csv

**Admin only.** The approved log as a spreadsheet — this is the "log it
somewhere" deliverable.

```csv
submission_id,submitter_user_id,platform,author_handle,url,posted_at,
submitted_at,approved_at,approved_by,views_at_approval,current_views,
current_views_as_of,flags
```

Both view columns are present so whichever basis you pay on, you can show your
work. Values beginning `=`, `+`, `-`, or `@` are prefixed with `'` to neutralize
spreadsheet formula injection — captions and handles are user-controlled.

---

## POST /campaigns

Creates a campaign. **Admin only.**

```json
{
  "chatId": "chat_abc",
  "name": "Hype Creator Push",
  "startsAt": 1760000000,
  "endsAt": null,
  "minViews": 1000
}
```

Fails if the chat already has an active campaign — the partial unique index
enforces one at a time.

---

## GET /campaigns/by-chat/:chatId

The active campaign for a chat, or `404`.

---

## Permission summary

| Endpoint | Required |
|---|---|
| `POST /chat/messages` | Chat member |
| `GET /campaigns/:id/submissions` | Chat member (actions filtered per viewer) |
| `GET /submissions/:id` | Chat member |
| `POST /submissions/:id/decision` | **Campaign admin** |
| `POST /submissions/:id/refresh` | **Campaign admin** |
| `GET /campaigns/:id/leaderboard` | Chat member |
| `GET /campaigns/:id/export.csv` | **Campaign admin** |
| `POST /campaigns` | **Campaign admin** |

## Idempotency

`POST /chat/messages` is **not** idempotent — the same `messageId` delivered
twice creates one submission and then a `DUPLICATE` refusal, which is the
correct outcome but produces a confusing ephemeral message. If your message
pipeline can redeliver, dedupe on `message_id` before calling.

`POST /submissions/:id/decision` is effectively idempotent: the second identical
call returns `409 ALREADY_DECIDED` and changes nothing.
