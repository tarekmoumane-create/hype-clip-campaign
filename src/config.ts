import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env loader so the reference server runs with no extra dependency.
 * Real values always come from the process environment first.
 */
function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int('PORT', 3000),

  viewProvider: (process.env.VIEW_PROVIDER ?? 'scrapecreators') as
    | 'scrapecreators'
    | 'mock',

  scrapeCreators: {
    apiKey: process.env.SCRAPECREATORS_API_KEY ?? '',
    baseUrl: 'https://api.scrapecreators.com',
    /** Cached Instagram reads cost 0 credits. */
    igCacheMaxAge: process.env.IG_CACHE_MAX_AGE ?? '1d',
    timeoutMs: int('SCRAPECREATORS_TIMEOUT_MS', 20_000),
  },

  databasePath: process.env.DATABASE_PATH ?? './data/campaign.sqlite',

  refreshMinIntervalSeconds: int('REFRESH_MIN_INTERVAL_SECONDS', 21_600),

  /**
   * Reference-server-only shortcut for admin identity. The real app must use
   * its existing group-admin role instead — see docs/06-admin-flows.md.
   */
  adminUserIds: (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
} as const;

export function assertProviderConfigured(): void {
  if (config.viewProvider === 'scrapecreators' && !config.scrapeCreators.apiKey) {
    throw new Error(
      'SCRAPECREATORS_API_KEY is not set. Copy .env.example to .env and fill it in, ' +
        'or set VIEW_PROVIDER=mock to run offline.',
    );
  }
}
