import { extractFirstUrl, normalizeHandle } from './url.js';
import type { Platform } from '../types.js';

/**
 * Parses chat messages into campaign commands.
 *
 * The submitter-facing surface is deliberately tiny — `/submit <link>` is the
 * only thing a participant has to learn. Everything else is a convenience.
 *
 * This is a pure function. It does no validation of the URL beyond finding
 * one; that happens in the submission pipeline where we can do network work.
 */

export type Command =
  | { kind: 'submit'; url: string }
  | { kind: 'claim_handle'; platform: Platform; handle: string }
  | { kind: 'my_stats' }
  | { kind: 'leaderboard' }
  | { kind: 'help' }
  /** Admin fallbacks for when the inline card is unavailable. */
  | { kind: 'approve'; submissionRef: string }
  | { kind: 'decline'; submissionRef: string; reason: string | null }
  | { kind: 'queue' }
  /** Recognized as a command but malformed; `message` is user-facing copy. */
  | { kind: 'error'; message: string };

const SUBMIT_ALIASES = new Set(['submit', 'clip', 'sub', 'post', 'entry']);
const CLAIM_ALIASES = new Set(['handle', 'claim', 'connect', 'link']);
const STATS_ALIASES = new Set(['me', 'mine', 'stats', 'mystats']);
const LEADERBOARD_ALIASES = new Set(['leaderboard', 'lb', 'top']);
const HELP_ALIASES = new Set(['help', 'commands', 'howto']);
const APPROVE_ALIASES = new Set(['approve', 'accept', 'ok']);
const DECLINE_ALIASES = new Set(['decline', 'reject', 'deny']);
const QUEUE_ALIASES = new Set(['queue', 'pending', 'review']);

const HELP_TEXT =
  'Submit a clip with `/submit <link>` (TikTok or Instagram). ' +
  'Set your handle with `/handle tiktok @yourname` so we can verify your posts. ' +
  '`/me` shows your submissions.';

export interface ParseCommandOptions {
  /**
   * When true, a message containing only a link counts as a submission.
   * Convenient, but noisy in a busy chat — off by default.
   */
  bareUrlSubmits?: boolean;
}

export function parseCommand(
  text: string,
  opts: ParseCommandOptions = {},
): Command | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith('/')) {
    if (opts.bareUrlSubmits) {
      const url = extractFirstUrl(trimmed);
      // Only treat it as a submission if the link is essentially the whole
      // message — otherwise we'd hijack ordinary conversation.
      if (url && trimmed.replace(url, '').trim().length <= 3) {
        return { kind: 'submit', url };
      }
    }
    return null;
  }

  const withoutSlash = trimmed.slice(1);
  const spaceAt = withoutSlash.search(/\s/);
  const verb = (spaceAt === -1 ? withoutSlash : withoutSlash.slice(0, spaceAt)).toLowerCase();
  const rest = spaceAt === -1 ? '' : withoutSlash.slice(spaceAt + 1).trim();

  if (SUBMIT_ALIASES.has(verb)) {
    const url = extractFirstUrl(rest) ?? (rest && !rest.includes(' ') ? rest : null);
    if (!url) {
      return {
        kind: 'error',
        message: 'Add the link after the command, like `/submit https://www.tiktok.com/@you/video/123`.',
      };
    }
    return { kind: 'submit', url };
  }

  if (CLAIM_ALIASES.has(verb)) {
    return parseClaim(rest);
  }

  if (STATS_ALIASES.has(verb)) return { kind: 'my_stats' };
  if (LEADERBOARD_ALIASES.has(verb)) return { kind: 'leaderboard' };
  if (HELP_ALIASES.has(verb)) return { kind: 'help' };
  if (QUEUE_ALIASES.has(verb)) return { kind: 'queue' };

  if (APPROVE_ALIASES.has(verb)) {
    if (!rest) return { kind: 'error', message: 'Usage: `/approve <submission id>`' };
    return { kind: 'approve', submissionRef: rest.split(/\s+/)[0] ?? rest };
  }

  if (DECLINE_ALIASES.has(verb)) {
    if (!rest) return { kind: 'error', message: 'Usage: `/decline <submission id> [reason]`' };
    const parts = rest.split(/\s+/);
    const ref = parts[0] ?? rest;
    const reason = parts.slice(1).join(' ').trim();
    return { kind: 'decline', submissionRef: ref, reason: reason || null };
  }

  // Unknown slash command — not ours. Return null so the app's own command
  // router can handle it rather than us swallowing it.
  return null;
}

function parseClaim(rest: string): Command {
  if (!rest) {
    return {
      kind: 'error',
      message: 'Usage: `/handle tiktok @yourname` or `/handle instagram @yourname`',
    };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  let platform: Platform | null = null;
  let handleToken: string | null = null;
  const extras: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'tiktok' || lower === 'tt') platform = 'tiktok';
    else if (lower === 'instagram' || lower === 'ig' || lower === 'insta') platform = 'instagram';
    else if (!handleToken) handleToken = token;
    else extras.push(token);
  }

  // Anything left over means the input was not a bare handle. Silently taking
  // the first token would claim the wrong name for the user.
  if (extras.length > 0) {
    return {
      kind: 'error',
      message: 'A handle cannot contain spaces. Try `/handle tiktok @yourname`.',
    };
  }

  // Allow inferring the platform from a pasted profile URL.
  if (!platform && handleToken) {
    if (/tiktok\.com/i.test(handleToken)) platform = 'tiktok';
    else if (/instagram\.com|instagr\.am/i.test(handleToken)) platform = 'instagram';
  }

  if (!platform) {
    return { kind: 'error', message: 'Say which platform: `/handle tiktok @yourname`' };
  }
  if (!handleToken) {
    return { kind: 'error', message: 'Add your handle: `/handle tiktok @yourname`' };
  }

  // Accept a profile URL in place of a bare handle.
  const fromUrl = handleToken.match(/(?:tiktok\.com\/@|instagram\.com\/)([A-Za-z0-9._]+)/i);
  const raw = fromUrl?.[1] ?? handleToken;
  const handle = normalizeHandle(raw);

  if (!/^[a-z0-9._]{1,30}$/.test(handle)) {
    return { kind: 'error', message: `\`${raw}\` is not a valid handle.` };
  }

  return { kind: 'claim_handle', platform, handle };
}

export { HELP_TEXT };
