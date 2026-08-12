# Hype Clip Campaign

In-chat video submission and approval for content campaigns.

Members of a Hype groupchat post a TikTok or Instagram link with `/submit`. The
system reads the video's public view count, checks the video was actually posted
by the person submitting it, and renders a card in the chat. Admins approve or
decline from that card. Approved clips are logged with their view counts and
tracked over time.

This repository is a **specification plus a runnable reference implementation**.
The code is not meant to ship as-is — it exists so every decision is concrete
and every flow can be exercised before it is built into the app.

---

## Status

Verified live against the Scrape Creators API on 2026-08-12.

| Component | State |
|---|---|
| TikTok view counts | Verified live |
| Instagram view counts | Verified live |
| URL parsing, dedup, canonicalization | 152 tests passing |
| Submission state machine | Verified, with permission guards |
| Handle-claim ownership checks | Verified |
| Chat card contract | Defined, rendered by reference server |
| View refresh + history | Implemented, cost-bounded |

---

## Quick start

```bash
npm install
cp .env.example .env          # add your SCRAPECREATORS_API_KEY

# Run offline with synthetic data — no API credits spent
VIEW_PROVIDER=mock npm run seed
VIEW_PROVIDER=mock ADMIN_USER_IDS=admin_1 npm start

# Confirm the live API works (costs 1 credit per URL)
npm run verify -- https://www.tiktok.com/@stoolpresidente/video/7463250363559218474

npm test
npm run typecheck
```

Then drive it like the app would:

```bash
# A member submits a clip
curl -X POST localhost:3000/chat/messages \
  -H 'X-User-Id: user_alice' -H 'content-type: application/json' \
  -d '{"chatId":"demo_chat","text":"/submit https://www.tiktok.com/@alice/video/123"}'

# An admin approves it
curl -X POST localhost:3000/submissions/<id>/decision \
  -H 'X-User-Id: admin_1' -H 'content-type: application/json' \
  -d '{"action":"approve"}'

# Export the approved log
curl -H 'X-User-Id: admin_1' localhost:3000/campaigns/<campaignId>/export.csv
```

---

## How it works

```
member types  /submit <link>
      │
      ▼
┌─────────────────┐   parse platform, strip tracking params,
│  URL parser     │   resolve vm.tiktok.com short links,
└─────────────────┘   extract a stable video id
      │
      ▼
┌─────────────────┐   already submitted in this campaign?
│  dedup check    │   → refuse before spending a credit
└─────────────────┘
      │
      ▼
┌─────────────────┐   Scrape Creators: views, likes, author,
│  view provider  │   posted-at, caption
└─────────────────┘
      │
      ▼
┌─────────────────┐   does the video's author match the handle
│  ownership check│   this member claimed? → flag, don't block
└─────────────────┘
      │
      ▼
┌─────────────────┐   posted to chat; Approve / Decline render
│  submission card│   for admins only
└─────────────────┘
      │
      ▼
┌─────────────────┐   views frozen at approval, then re-polled
│  approved log   │   on a schedule to track growth
└─────────────────┘
```

---

## Documentation

Read in order. `01` and `02` are the ones to read before writing any code.

| Doc | What it covers |
|---|---|
| [01 — Overview](docs/01-overview.md) | What gets built, scope, the decisions already made and why |
| [02 — Data model](docs/02-data-model.md) | Tables, fields, indexes, the two view-count columns |
| [03 — Submitter experience](docs/03-submitter-experience.md) | `/submit` and the other commands, copy for every outcome |
| [04 — API contracts](docs/04-api-contracts.md) | Endpoints, payloads, status codes, permissions |
| [05 — Chat card spec](docs/05-chat-card-spec.md) | Card layout, states, who sees which buttons |
| [06 — Admin flows](docs/06-admin-flows.md) | Approve, decline, reopen, bulk review, the audit trail |
| [07 — Anti-fraud](docs/07-anti-fraud.md) | Handle claiming, what it catches, what it does not |
| [08 — View refresh & costs](docs/08-view-refresh-and-costs.md) | Refresh cadence, credit budgeting, what a campaign costs |
| [09 — Edge cases](docs/09-edge-cases.md) | Deleted posts, private accounts, duplicates, races |
| [10 — Acceptance criteria](docs/10-acceptance-criteria.md) | Testable checklist for "this is done" |

---

## Repository layout

```
docs/                    the specification — start here
migrations/001_init.sql  canonical PostgreSQL schema

src/
  parse/url.ts           platform detection, canonicalization, dedup ids
  parse/command.ts       chat command parsing
  providers/             ViewCountProvider interface + Scrape Creators adapter
  domain/submission.ts   approve / decline / reopen state machine
  domain/fraud.ts        handle-ownership and eligibility checks
  service/campaign.ts    orchestration — the layer the app calls into
  service/chat.ts        message in, chat responses out
  render/card.ts         the card payload the client renders
  db/                    Repository interface + SQLite reference store
  jobs/refresh.ts        scheduled view re-polling
  export/csv.ts          approved-clip log export
  cli/verify.ts          live provider check
  cli/seed.ts            demo data

tests/                   152 tests, no network required
```

---

## What the app team actually needs to build

The reference server exists to be read and discarded. Four pieces port directly:

1. **`src/parse/`** — copy the logic. URL canonicalization and dedup ids are
   fiddly, and the tests encode a lot of real-world URL shapes.
2. **`src/domain/`** — pure functions, no dependencies. Port as-is.
3. **`migrations/001_init.sql`** — run against your database.
4. **`src/render/card.ts`** — the card contract your clients render.

Everything else (Express routes, SQLite store, header-based identity) is
scaffolding to make the above runnable. Replace it with the app's own HTTP
layer, database, and group-admin role.

---

## Important constraints

**Credits.** Every view read costs one Scrape Creators credit. A campaign with
200 approved clips refreshing every 6 hours spends ~800/day. Budget before
enabling the refresh job — see [08](docs/08-view-refresh-and-costs.md).

**Instagram needs public accounts.** Private or restricted posts return no view
count. The submission is still recorded and flagged for the admin.

**Views are plays.** Both platforms report a play count, which is what the
campaign scores on. Instagram also exposes a separate, smaller "views" number;
the adapter deliberately prefers plays and falls back only if plays are absent.

**Rotate the API key** before this repository leaves your hands if the key was
ever shared in a chat transcript.
