import type { CampaignService } from '../service/campaign.js';

/**
 * Periodic view-count refresh.
 *
 * A content campaign is judged on how videos perform over days, not on the
 * number they had thirty seconds after posting. This job keeps `latest_views`
 * current and appends to `view_snapshots` so growth curves survive.
 *
 * Cost control matters here. Every refresh is a paid API call, so:
 *   - only approved submissions refresh on a schedule
 *   - each one refreshes at most once per REFRESH_MIN_INTERVAL_SECONDS
 *   - Instagram calls pass `cache_max_age`, and a cache hit is free
 *
 * At 200 approved clips refreshing every 6 hours that is ~800 calls/day. Size
 * your credit balance against your real clip count before turning this on.
 */

export interface RefreshJobOptions {
  /** How often to wake up and look for due work. Default 15 minutes. */
  intervalMs?: number;
  /** Maximum submissions refreshed per tick. Default 25. */
  batchSize?: number;
  /** Skip the immediate run at startup. */
  skipInitialRun?: boolean;
}

export function startRefreshJob(
  service: CampaignService,
  opts: RefreshJobOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 15 * 60 * 1000;
  const batchSize = opts.batchSize ?? 25;

  let running = false;

  const tick = async (): Promise<void> => {
    // Never let two ticks overlap — a slow provider would otherwise stack
    // requests and burn credits twice as fast as intended.
    if (running) return;
    running = true;
    try {
      const { refreshed, failed } = await service.refreshDue(batchSize);
      if (refreshed > 0 || failed > 0) {
        console.log(`[refresh] updated ${refreshed}, failed ${failed}`);
      }
    } catch (error) {
      console.error('[refresh] tick failed', error);
    } finally {
      running = false;
    }
  };

  if (!opts.skipInitialRun) void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // Do not hold the process open just for this.
  timer.unref?.();

  return () => clearInterval(timer);
}
