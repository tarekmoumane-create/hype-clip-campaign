# 05 — Chat card spec

Implementation: [`src/render/card.ts`](../src/render/card.ts).

## The rule that matters most

**The server decides which buttons exist. The client only draws them.**

If the client decided whether to render Approve/Decline, a patched client could
draw them for anyone. The server re-checks permission on the action itself
regardless — but not shipping the buttons to non-admins keeps the two layers
honest and means the card payload is the single source of truth.

`buildCard()` takes the viewer's identity and returns a payload whose `actions`
array is already correct for that viewer. Render exactly what is in it.

## Payload

```ts
interface SubmissionCard {
  submissionId: string
  status: 'pending' | 'approved' | 'declined'
  platform: 'tiktok' | 'instagram'
  url: string                    // tapping the card opens this
  submitterUserId: string
  submitterLabel: string         // "@alice"
  authorHandle: string | null    // who actually posted it

  views: number | null           // raw, for sorting
  viewsLabel: string             // "12.4K" or "—"
  viewsAsOf: number | null       // unix ms of that reading

  caption: string | null         // truncated to 120 chars
  postedAt: number | null        // unix seconds

  flags: { code, label, severity: 'warning' | 'info' }[]
  statusLabel: string            // "Pending review", "Approved by @tarek"
  actions: CardAction[]          // EMPTY for non-admins
  fallbackText: string           // plain text for clients without rich cards
}

interface CardAction {
  id: 'approve' | 'decline' | 'reopen'
  label: string
  style: 'primary' | 'danger' | 'neutral'
  confirm?: boolean              // client must confirm before firing
}
```

## Layout

Member's view — pending:

```
┌──────────────────────────────────────────┐
│ ▶  @alice submitted a TikTok clip        │
│                                          │
│    "this app is actually insane"         │
│    tiktok.com/@alice/video/7463…         │
│                                          │
│    👁  12.4K views · 2h ago              │
│    ⏳ Pending review                      │
└──────────────────────────────────────────┘
```

Admin's view — same submission, with a warning flag:

```
┌──────────────────────────────────────────┐
│ ▶  @bob submitted a TikTok clip          │
│                                          │
│    "check this out"                      │
│    tiktok.com/@someone_else/video/739…   │
│                                          │
│    👁  88.2K views · 5m ago              │
│                                          │
│    ⚠️  Posted by a different account      │
│        than this user claimed            │
│                                          │
│    ⏳ Pending — needs a look              │
│                                          │
│    [  Approve  ]   [  Decline  ]         │
└──────────────────────────────────────────┘
```

After approval, for everyone:

```
┌──────────────────────────────────────────┐
│ ▶  @alice submitted a TikTok clip        │
│    tiktok.com/@alice/video/7463…         │
│                                          │
│    👁  12.4K views                       │
│    ✅ Approved by @tarek                  │
└──────────────────────────────────────────┘
```

## Action visibility

| Viewer | Status | Actions |
|---|---|---|
| Member | any | *(none)* |
| Admin | `pending` | Approve, Decline |
| Admin | `pending`, own submission | *(none)* — see below |
| Admin | `approved` / `declined` | Reopen |

**Admins cannot approve their own submissions.** If approvals map to rewards,
self-approval is the first thing anyone will try. An admin can still *decline*
their own entry — that harms no one. Configurable via `allowSelfApproval` if
your campaign genuinely needs it.

Decline carries `confirm: true`. It is the destructive action and it is adjacent
to the one admins will tap hundreds of times.

## Flags

| Code | Label | Severity |
|---|---|---|
| `HANDLE_MISMATCH` | Posted by a different account than this user claimed | warning |
| `POSTED_BEFORE_CAMPAIGN` | Video was posted before the campaign started | warning |
| `NO_CLAIMED_HANDLE` | User has not linked a handle on this platform | info |
| `METRICS_UNAVAILABLE` | View count could not be read | info |
| `LOW_VIEWS` | Below the campaign view minimum | info |

Render `warning` with visual weight — colour, icon, whatever your design system
uses for "look at this". Render `info` quietly. A card carrying any warning flag
gets the status line "Pending — needs a look" instead of "Pending review", so an
admin scrolling fast still catches it.

Flags never hide the Approve button. They inform the decision; they do not make
it.

## View counts

- `viewsLabel` is pre-formatted: `0`, `999`, `1.2K`, `12K`, `1.9M`, `2.4B`, `—`.
  Formatting server-side keeps every platform's clients consistent.
- **Always show `viewsAsOf`** as relative time ("12.4K views · 2h ago"). The
  number is a point-in-time reading, and a card that implies it is live will be
  wrong within the hour.
- `—` means the count could not be read. It does not mean zero, and it must not
  render as `0`.

## Updating a card

After a decision the server returns a `card_update`. Replace the existing card
in place — do not post a new message. The chat should read as a log of
submissions with current status, not as a stream of state-change announcements.

Match on `submissionId`. If the original message is gone, drop the update
silently.

## Fallback

Every card includes `fallbackText`:

```
@alice submitted a TikTok clip
https://www.tiktok.com/@alice/video/7463250363559218474
Views: 12.4K
Status: pending
Flags: User has not linked a handle on this platform
```

Use it for push notifications, chat previews, clients that predate rich cards,
and accessibility surfaces.

## Accessibility

- The card is a link — give it an accessible name that includes submitter,
  platform, and view count, not just "card".
- Never encode flag severity in colour alone. The icon and label carry it.
- Approve and Decline need labels, not just icons.
