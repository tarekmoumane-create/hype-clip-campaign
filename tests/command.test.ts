import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parse/command.js';

describe('/submit', () => {
  it('parses the primary form', () => {
    expect(parseCommand('/submit https://www.tiktok.com/@u/video/1')).toEqual({
      kind: 'submit',
      url: 'https://www.tiktok.com/@u/video/1',
    });
  });

  it.each(['/clip', '/sub', '/post', '/entry'])('accepts the %s alias', (alias) => {
    expect(parseCommand(`${alias} https://www.tiktok.com/@u/video/1`)).toMatchObject({
      kind: 'submit',
    });
  });

  it('is case insensitive on the verb', () => {
    expect(parseCommand('/SUBMIT https://www.tiktok.com/@u/video/1')).toMatchObject({
      kind: 'submit',
    });
  });

  it('tolerates extra words around the link', () => {
    expect(parseCommand('/submit here you go https://www.tiktok.com/@u/video/1 thanks')).toEqual({
      kind: 'submit',
      url: 'https://www.tiktok.com/@u/video/1',
    });
  });

  it('accepts a bare domain with no scheme', () => {
    expect(parseCommand('/submit tiktok.com/@u/video/1')).toEqual({
      kind: 'submit',
      url: 'tiktok.com/@u/video/1',
    });
  });

  it('explains itself when the link is missing', () => {
    const result = parseCommand('/submit');
    expect(result?.kind).toBe('error');
  });
});

describe('bare URL mode', () => {
  it('is off by default', () => {
    expect(parseCommand('https://www.tiktok.com/@u/video/1')).toBeNull();
  });

  it('submits a lone link when enabled', () => {
    expect(
      parseCommand('https://www.tiktok.com/@u/video/1', { bareUrlSubmits: true }),
    ).toMatchObject({ kind: 'submit' });
  });

  it('ignores a link embedded in conversation even when enabled', () => {
    expect(
      parseCommand('have you all seen https://www.tiktok.com/@u/video/1 lol', {
        bareUrlSubmits: true,
      }),
    ).toBeNull();
  });
});

describe('/handle', () => {
  it('parses platform and handle', () => {
    expect(parseCommand('/handle tiktok @alice_makes')).toEqual({
      kind: 'claim_handle',
      platform: 'tiktok',
      handle: 'alice_makes',
    });
  });

  it('accepts the handle before the platform', () => {
    expect(parseCommand('/handle @alice_makes tiktok')).toMatchObject({
      platform: 'tiktok',
      handle: 'alice_makes',
    });
  });

  it.each([
    ['tt', 'tiktok'],
    ['ig', 'instagram'],
    ['insta', 'instagram'],
    ['instagram', 'instagram'],
  ])('accepts the %s platform alias', (alias, expected) => {
    expect(parseCommand(`/handle ${alias} @someone`)).toMatchObject({ platform: expected });
  });

  it('infers the platform from a pasted profile URL', () => {
    expect(parseCommand('/handle https://www.tiktok.com/@alice_makes')).toEqual({
      kind: 'claim_handle',
      platform: 'tiktok',
      handle: 'alice_makes',
    });
  });

  it('works without the leading @', () => {
    expect(parseCommand('/handle tiktok alice_makes')).toMatchObject({ handle: 'alice_makes' });
  });

  it('errors when the platform is ambiguous', () => {
    expect(parseCommand('/handle @alice')?.kind).toBe('error');
  });

  it('rejects a handle with illegal characters', () => {
    expect(parseCommand('/handle tiktok @not a handle!')?.kind).toBe('error');
  });
});

describe('admin commands', () => {
  it('parses /approve', () => {
    expect(parseCommand('/approve sub_123')).toEqual({ kind: 'approve', submissionRef: 'sub_123' });
  });

  it('parses /decline with a reason', () => {
    expect(parseCommand('/decline sub_123 not on brand')).toEqual({
      kind: 'decline',
      submissionRef: 'sub_123',
      reason: 'not on brand',
    });
  });

  it('parses /decline with no reason', () => {
    expect(parseCommand('/decline sub_123')).toEqual({
      kind: 'decline',
      submissionRef: 'sub_123',
      reason: null,
    });
  });
});

describe('routing', () => {
  it('returns null for unrelated slash commands so the app can handle them', () => {
    expect(parseCommand('/mute @someone')).toBeNull();
    expect(parseCommand('/price BTC')).toBeNull();
  });

  it('returns null for ordinary chat', () => {
    expect(parseCommand('gm everyone')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });

  it('parses the read-only commands', () => {
    expect(parseCommand('/me')).toEqual({ kind: 'my_stats' });
    expect(parseCommand('/leaderboard')).toEqual({ kind: 'leaderboard' });
    expect(parseCommand('/queue')).toEqual({ kind: 'queue' });
    expect(parseCommand('/help')).toEqual({ kind: 'help' });
  });
});
