# 03 — Submitter experience

Implementation: [`src/parse/command.ts`](../src/parse/command.ts),
[`src/service/chat.ts`](../src/service/chat.ts).

## The one command that matters

```
/submit https://www.tiktok.com/@alice/video/7463250363559218474
```

That is the whole thing a participant has to learn. Everything else is optional.

Accepted aliases: `/submit`, `/clip`, `/sub`, `/post`, `/entry`. The verb is
case-insensitive, and extra words around the link are tolerated —
`/submit here you go <link> 🔥` works.

## Full command list

| Command | Who | What it does |
|---|---|---|
| `/submit <link>` | anyone | Enters a clip |
| `/handle tiktok @you` | anyone | Links a social account, once |
| `/me` | anyone | Your submissions and their status |
| `/leaderboard` | anyone | Top members by views |
| `/help` | anyone | Reminds people of the above |
| `/queue` | admin | Lists pending submissions as cards |
| `/approve <id>` | admin | Fallback for when card buttons are unavailable |
| `/decline <id> [reason]` | admin | Same |

`/handle` accepts `tiktok`, `tt`, `instagram`, `ig`, `insta`, in either order
relative to the handle, with or without the `@`, and will infer the platform
from a pasted profile URL:

```
/handle tiktok @alice_makes
/handle @alice_makes ig
/handle https://www.tiktok.com/@alice_makes     → platform inferred
```

## Unrecognized slash commands pass through

`parseCommand` returns `null` for anything that is not a campaign command, so
`/mute`, `/price`, and every other existing Hype command reach their own
handlers untouched. Do not let this feature swallow the namespace.

## Bare links are ignored by default

A message containing only a link does **not** count as a submission unless
`bareUrlSubmits` is enabled. In an active groupchat people paste links
constantly; auto-submitting them would produce a queue full of noise and enter
people into a campaign they did not mean to join.

If you do turn it on, the parser only treats a message as a submission when the
link is essentially the entire message — a link inside a sentence stays
conversation.

## Which links work

**TikTok**

```
https://www.tiktok.com/@user/video/7463250363559218474    standard
https://www.tiktok.com/@user/photo/7463250363559218474    photo posts
https://vm.tiktok.com/ZMabc123/                           share sheet
https://vt.tiktok.com/ZSabc123/                           share sheet
https://www.tiktok.com/t/ZTabc123/                        share sheet
https://m.tiktok.com/v/7463250363559218474.html           mobile
```

**Instagram**

```
https://www.instagram.com/reel/Dbru79IAdH-/
https://www.instagram.com/reels/Dbru79IAdH-/
https://www.instagram.com/p/Dbru79IAdH-/
https://www.instagram.com/tv/Dbru79IAdH-/
https://www.instagram.com/username/reel/Dbru79IAdH-/
https://instagr.am/p/Dbru79IAdH-/
```

Tracking parameters (`?is_from_webapp`, `?igsh`, `utm_*`, and ~25 others) are
stripped before storage. A scheme-less paste like `tiktok.com/@u/video/123` is
accepted.

Short links (`vm.`, `vt.`, `instagr.am`, `/t/`) are resolved over the network to
their canonical form before anything else happens, so the same video submitted
as a short link and as a full link is correctly caught as one entry.

## Copy for every outcome

Errors are **ephemeral** — visible only to the person who typed the command.
A mistyped link should not clutter the group.

| Situation | Message |
|---|---|
| Not a link | "That doesn't look like a link." |
| YouTube, X, etc. | "Only TikTok and Instagram links are accepted right now." |
| Profile instead of a video | "That link is not a video post. Use the link to the video itself, not a profile." |
| Short link would not resolve | "Could not open that short link. Paste the full link from the post instead." |
| Already submitted by them | "You already submitted that video." |
| Already submitted by someone else | "That video has already been submitted by someone else." |
| No campaign running | "There is no active campaign in this chat right now." |
| Campaign over | "The <name> campaign has ended, so submissions are closed." |
| Post is private | "That post is private or restricted, so we cannot read its views. Make it public and resubmit." |
| Photo post, not video | "That post has no view count — make sure you are submitting a video, not a photo post." |
| Post not found / deleted | "We couldn't find that post. Is the link right, and is the post still up?" |
| Provider down | "We could not read the view count just now. It will retry automatically." |
| Handle already claimed | "@x is already linked to another member. If that's your account, ask an admin." |
| Handle has spaces | "A handle cannot contain spaces. Try `/handle tiktok @yourname`." |

Two rules behind this table:

**Never show internal errors to members.** `ProviderError.userMessage()` maps
every failure code to safe copy. Vendor names, HTTP statuses, and stack traces
stay in the logs.

**A failed view read does not lose the submission.** The entry is recorded as
pending with a `METRICS_UNAVAILABLE` flag, and the member is told privately that
it went through but the count is pending. Losing a real entry because a vendor
had a bad minute is worse than showing an admin a warning.

## What the submitter sees on success

A card appears **in the chat**, visible to everyone (see
[05](05-chat-card-spec.md)). The submitter gets no separate confirmation — the
card is the confirmation. Posting it publicly is deliberate: it makes the
campaign feel alive, and it makes duplicate submissions socially obvious before
they are mechanically caught.
