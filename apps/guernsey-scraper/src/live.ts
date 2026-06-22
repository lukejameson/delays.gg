import { db, flights, flightTimes, scraperLogs, guernseyHour, guernseyTodayStr as guernseyDateStr, guernseyTomorrowStr, nextGuernseyTime, checkTimezoneOffset, isTerminalStatus, tryAcquireServiceLock, clearAllTimers, countFlightsForDate, getActiveFlightsToday, getEstimatedTimesBatch, msSinceLastScrape, logSchedulerEvent, computeNextInterval, shouldSleep, computeWakeTime, type TimerState } from '@airways/database';
import { eq, and, not, inArray, asc, count, desc, max, sql } from 'drizzle-orm';
import { scrapeDayFlights } from './scraper';
import { sendAlert } from '@airways/telegram';
import { createCircuitBreakerFromEnv, mins } from '@airways/common';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Hour (0–23, Guernsey local) at which the scraper hard-stops for the night */
const CUTOFF_HOUR          = parseInt(process.env.SCRAPER_CUTOFF_HOUR              || '23', 10);
/** Minutes before the first scheduled flight to wake up from sleep */
const WAKE_OFFSET_MINS     = parseInt(process.env.SCRAPER_WAKE_OFFSET_MINS         || '30', 10);
/** Interval when < 20 min to next flight event (minutes) */
const INTERVAL_HIGH_MINS   = parseInt(process.env.SCRAPER_INTERVAL_HIGH_MINS       || '2',  10);
/** Interval when 20–60 min to next flight event (minutes) */
const INTERVAL_MEDIUM_MINS = parseInt(process.env.SCRAPER_INTERVAL_MEDIUM_MINS     || '5',  10);
/** Interval when 60–120 min to next flight event (minutes) */
const INTERVAL_LOW_MINS    = parseInt(process.env.SCRAPER_INTERVAL_LOW_MINS        || '10', 10);
/** Interval when > 120 min to next flight event (minutes) */
const INTERVAL_IDLE_MINS   = parseInt(process.env.SCRAPER_INTERVAL_IDLE_MINS       || '15', 10);
/** Minimum interval between tomorrow scrapes (minutes) */
const INTERVAL_TOMORROW_MINS = parseInt(process.env.SCRAPER_INTERVAL_TOMORROW_MINS || '360', 10);

/** Circuit breaker: failures before opening */
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.SCRAPER_CIRCUIT_BREAKER_THRESHOLD || '5', 10);
/** Circuit breaker: reset timeout (ms) */
const CIRCUIT_BREAKER_RESET_MS  = parseInt(process.env.SCRAPER_CIRCUIT_BREAKER_RESET_MS  || '60000', 10);

const TZ_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const timers: TimerState = {
  scrapeTimeout: null,
  wakeTimeout: null,
  prefetchSlotTimeout: null,
  tzCheckTimeout: null,
};

const circuitBreaker = createCircuitBreakerFromEnv('Guernsey', CIRCUIT_BREAKER_THRESHOLD, CIRCUIT_BREAKER_RESET_MS);

let lastTomorrowScrapeAt: Date | null = null;
let scheduledWakeAtMs: number | null = null;

const clearTimers = () => clearAllTimers(timers);

// ---------------------------------------------------------------------------
// Scrape execution
// ---------------------------------------------------------------------------

async function runLiveScrape(includeTomorrow: boolean): Promise<void> {
  const startedAt = new Date();
  let totalFlights = 0;
  let totalUpdates = 0;

  const logEntry = await db
    .insert(scraperLogs)
    .values({ service: 'guernsey_live', status: 'retry', startedAt })
    .returning({ id: scraperLogs.id });
  const logId = logEntry[0].id;

  try {
    const todayStr = guernseyDateStr();
    const todayDate = new Date(todayStr);
    const todayResult = await scrapeDayFlights(todayDate);
    totalFlights += todayResult.flights;
    totalUpdates += todayResult.updates;
    if (includeTomorrow) {
      const tomorrowStr = guernseyTomorrowStr();
      const tomorrowDate = new Date(tomorrowStr);
      const tomorrowResult = await scrapeDayFlights(tomorrowDate);
      totalFlights += tomorrowResult.flights;
      totalUpdates += tomorrowResult.updates;
      lastTomorrowScrapeAt = new Date();
    }

    await db
      .update(scraperLogs)
      .set({ status: 'success', recordsScraped: totalUpdates, completedAt: new Date() })
      .where(eq(scraperLogs.id, logId));

    console.log(`[Guernsey Live] Scraped today${includeTomorrow ? '+tomorrow' : ''}: ${totalFlights} flights, ${totalUpdates} updates`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[Guernsey Live] Scrape error:', errorMessage);
    sendAlert('guernsey-scraper', 'warning', 'Live scrape failed', err).catch(() => {});

    await db
      .update(scraperLogs)
      .set({ status: 'failure', errorMessage, completedAt: new Date() })
      .where(eq(scraperLogs.id, logId));
  }
}

// ---------------------------------------------------------------------------
// Wall-clock prefetch scheduler (00:00, 06:00, 12:00, 18:00 GY local)
// ---------------------------------------------------------------------------

async function runBackgroundPrefetch(): Promise<void> {
  const todayStr = guernseyDateStr();
  const tomorrowStr = guernseyTomorrowStr();
  console.log(`[Guernsey Live] Background prefetch: fetching ${todayStr} + ${tomorrowStr}...`);

  try {
    const todayDate = new Date(todayStr);
    const tomorrowDate = new Date(tomorrowStr);
    const todayResult = await scrapeDayFlights(todayDate);
    const tomorrowResult = await scrapeDayFlights(tomorrowDate);
    lastTomorrowScrapeAt = new Date();

    const totalFlights = todayResult.flights + tomorrowResult.flights;
    const msg = `${totalFlights} flights scraped for ${todayStr} + ${tomorrowStr}`;
    console.log(`[Guernsey Live] Background prefetch complete: ${msg}`);
    await logSchedulerEvent('guernsey_live', 'prefetch', msg);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[Guernsey Live] Background prefetch failed:', errorMessage);
    await logSchedulerEvent('guernsey_live', 'prefetch', `failed — ${errorMessage}`);
  }

  // If sleeping, check whether newly loaded data changes wake time
  if (timers.wakeTimeout !== null && scheduledWakeAtMs !== null) {
    const todayStr = guernseyDateStr();
    const tomorrowStr = guernseyTomorrowStr();
    const currentHour = guernseyHour();
    const { wakeAt, reason } = await computeWakeTime(todayStr, tomorrowStr, currentHour, CUTOFF_HOUR, WAKE_OFFSET_MINS);

    if (wakeAt.getTime() <= Date.now()) {
      console.log(`[Guernsey Live] Prefetch detected we should already be awake — cancelling sleep`);
      clearTimeout(timers.wakeTimeout);
      timers.wakeTimeout = null;
      scheduledWakeAtMs = null;
      await logSchedulerEvent('guernsey_live', 'wake', `Early wake triggered by prefetch — ${reason}`);
      try {
        await runLiveScrape(false);
        await scheduleNextScrape();
      } catch (err) {
        console.error('[Guernsey Live] Error in prefetch-triggered wake:', err);
        await scheduleNextScrape();
      }
      return;
    }

    const diffMs = Math.abs(wakeAt.getTime() - scheduledWakeAtMs);
    if (diffMs > 5 * 60_000) {
      console.log(`[Guernsey Live] Prefetch updated first-flight data — rescheduling wake to ${wakeAt.toISOString()}`);
      clearTimeout(timers.wakeTimeout);
      scheduledWakeAtMs = wakeAt.getTime();
      const sleepMs = Math.max(0, wakeAt.getTime() - Date.now());
      timers.wakeTimeout = setTimeout(async () => {
        try {
          timers.wakeTimeout = null;
          scheduledWakeAtMs = null;
          await logSchedulerEvent('guernsey_live', 'wake', `Waking up (rescheduled by prefetch) — ${reason}`);
          await runLiveScrape(false);
          await scheduleNextScrape();
        } catch (err) {
          console.error('[Guernsey Live] Error in rescheduled wake:', err);
          timers.wakeTimeout = null;
          scheduledWakeAtMs = null;
          try { await scheduleNextScrape(); } catch {
            setTimeout(() => scheduleNextScrape().catch(e => console.error('[Guernsey Live] Fatal retry failed:', e)), 5 * 60 * 1000);
          }
        }
      }, sleepMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Timezone offset health check — runs every 30 minutes during active hours
// ---------------------------------------------------------------------------

async function scheduleTzCheck(): Promise<void> {
  if (timers.tzCheckTimeout) {
    clearTimeout(timers.tzCheckTimeout);
    timers.tzCheckTimeout = null;
  }

  timers.tzCheckTimeout = setTimeout(async () => {
    timers.tzCheckTimeout = null;

    try {
      const result = checkTimezoneOffset();
      if (!result.ok) {
        const level = result.detectedOffset === 0 && result.expectedLabel.includes('BST') ? 'critical' : 'warning';
        console.error(`[Guernsey Live] ${result.details}`);
        await sendAlert('guernsey-live', level, `Timezone offset mismatch on ${new Date().toISOString().split('T')[0]}: ${result.details}`);
      } else {
        console.log(`[Guernsey Live] ${result.details}`);
      }
    } catch (err) {
      console.error('[Guernsey Live] Timezone check error:', err);
      await sendAlert('guernsey-live', 'warning', 'Timezone check threw an exception', err);
    }

    await scheduleTzCheck();
  }, TZ_CHECK_INTERVAL_MS);
}

async function schedulePrefetchSlot(): Promise<void> {
  const SLOT_HOURS = [0, 6, 12, 18];
  const now = new Date();
  const currentHourGY = guernseyHour(now);

  let nextSlotHour = SLOT_HOURS.find(h => h > currentHourGY);
  if (nextSlotHour === undefined) {
    nextSlotHour = 0;
  }

  const nextSlotTime = nextGuernseyTime(nextSlotHour, 0);

  const slotMs = Math.max(0, nextSlotTime.getTime() - now.getTime());
  console.log(
    `[Guernsey Live] Next prefetch slot: ${nextSlotHour.toString().padStart(2, '0')}:00 GY ` +
    `(${Math.round(slotMs / 60_000)} minutes from now)`,
  );

  if (timers.prefetchSlotTimeout) {
    clearTimeout(timers.prefetchSlotTimeout);
    timers.prefetchSlotTimeout = null;
  }

  timers.prefetchSlotTimeout = setTimeout(async () => {
    timers.prefetchSlotTimeout = null;
    try {
      if (!circuitBreaker.check()) {
        console.log('[Guernsey Live] Circuit breaker open, skipping prefetch slot');
      } else {
        console.log('[Guernsey Live] Prefetch slot fired — running standalone');
        await runBackgroundPrefetch();
      }
      await schedulePrefetchSlot();
    } catch (err) {
      console.error('[Guernsey Live] Error in prefetch slot timeout:', err);
      setTimeout(() => schedulePrefetchSlot().catch(e => console.error('[Guernsey Live] Fatal prefetch slot error:', e)), 5 * 60 * 1000);
    }
  }, slotMs);
}

// ---------------------------------------------------------------------------
// Scheduling loop
// ---------------------------------------------------------------------------

async function scheduleNextScrape(): Promise<void> {
  const { sleep, reason } = await shouldSleep(guernseyDateStr(), CUTOFF_HOUR, guernseyHour());

  if (sleep) {
    await logSchedulerEvent('guernsey_live', 'sleep', reason);

    // Run final prefetch before sleeping
    console.log('[Guernsey Live] Running final prefetch before sleeping...');
    await runLiveScrape(true);

    const { wakeAt, reason: wakeReason } = await computeWakeTime(guernseyDateStr(), guernseyTomorrowStr(), guernseyHour(), CUTOFF_HOUR, WAKE_OFFSET_MINS);
    scheduledWakeAtMs = wakeAt.getTime();
    const sleepMs = Math.max(0, wakeAt.getTime() - Date.now());

    await logSchedulerEvent('guernsey_live', 'sleep', `Sleeping for ${Math.round(sleepMs / 60_000)}m. ${wakeReason}`);

    timers.wakeTimeout = setTimeout(async () => {
      try {
        timers.wakeTimeout = null;
        scheduledWakeAtMs = null;
        await logSchedulerEvent('guernsey_live', 'wake', `Waking up — ${wakeReason}`);
        await runLiveScrape(false);
        await scheduleNextScrape();
      } catch (err) {
        console.error('[Guernsey Live] Error in wake timeout:', err);
        sendAlert('guernsey-scraper', 'warning', 'Wake timeout callback error', err).catch(() => {});
        timers.wakeTimeout = null;
        scheduledWakeAtMs = null;
        try { await scheduleNextScrape(); } catch {
          setTimeout(() => scheduleNextScrape().catch(e => console.error('[Guernsey Live] Fatal retry failed:', e)), 5 * 60 * 1000);
        }
      }
    }, sleepMs);

    return;
  }

  // Active — compute dynamic interval with jitter
  const { ms, jitterMs, reason: intervalReason } = await computeNextInterval(guernseyDateStr(), mins(INTERVAL_HIGH_MINS), mins(INTERVAL_MEDIUM_MINS), mins(INTERVAL_LOW_MINS), mins(INTERVAL_IDLE_MINS));
  const totalMs = ms + jitterMs;

  console.log(
    `[Guernsey Live] Next scrape in ${Math.round(ms / 1000)}s + ${Math.round(jitterMs / 1000)}s jitter = ${Math.round(totalMs / 1000)}s. Reason: ${intervalReason}`,
  );

  // Include tomorrow if enough time has elapsed
  const includeTomorrow = !lastTomorrowScrapeAt ||
    (Date.now() - lastTomorrowScrapeAt.getTime()) > mins(INTERVAL_TOMORROW_MINS);

  if (timers.scrapeTimeout) {
    clearTimeout(timers.scrapeTimeout);
    timers.scrapeTimeout = null;
  }

  timers.scrapeTimeout = setTimeout(async () => {
    timers.scrapeTimeout = null;

    if (!circuitBreaker.check()) {
      console.log('[Guernsey Live] Circuit breaker open, skipping scrape and rescheduling');
      await scheduleNextScrape();
      return;
    }

    try {
      await runLiveScrape(includeTomorrow);
      circuitBreaker.recordSuccess();
    } catch (err) {
      console.error('[Guernsey Live] Error in scheduled scrape:', err);
      circuitBreaker.recordFailure();
    }
    await scheduleNextScrape();
  }, totalMs);
}

// ---------------------------------------------------------------------------
// Startup history check — ensure the last 10 days have data
// ---------------------------------------------------------------------------

/**
 * On startup, check that each of the 10 days prior to today has at least one
 * flight record. Any day with no data is backfilled before the live loop starts.
 * This ensures the web app always has recent history even after a long outage or
 * a fresh deployment.
 */
async function ensureRecentHistory(): Promise<void> {
  const today = guernseyDateStr();
  const missing: string[] = [];

  for (let i = 1; i <= 10; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const n = await countFlightsForDate(dateStr);
    if (n === 0) missing.push(dateStr);
  }

  if (missing.length === 0) {
    console.log('[Guernsey Live] Recent history OK — all 10 prior days have data');
    return;
  }

  console.log(`[Guernsey Live] Missing data for ${missing.length} of last 10 days: ${missing.join(', ')} — backfilling...`);

  for (const dateStr of missing) {
    try {
      const result = await scrapeDayFlights(new Date(dateStr));
      console.log(`[Guernsey Live] Backfilled ${dateStr}: ${result.flights} flights, ${result.updates} updates`);
    } catch (err) {
      console.error(`[Guernsey Live] Failed to backfill ${dateStr}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('[Guernsey Live] Recent history backfill complete');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runLiveMode(): Promise<void> {
  // Prevent duplicate instances via PostgreSQL advisory lock.
  // If another guernsey_live process already holds the lock, exit immediately.
  const acquired = await tryAcquireServiceLock('guernsey_live');
  if (!acquired) {
    console.log('[Guernsey Live] Another instance is already running (lock held). Exiting.');
    process.exit(0);
  }

  console.log('[Guernsey Live] Starting live scraper...');
  console.log(`[Guernsey Live] Config — cutoff: ${CUTOFF_HOUR}:00 GY, wake offset: ${WAKE_OFFSET_MINS}m`);
  console.log(`[Guernsey Live] Intervals — high: ${INTERVAL_HIGH_MINS}m, medium: ${INTERVAL_MEDIUM_MINS}m, low: ${INTERVAL_LOW_MINS}m, idle: ${INTERVAL_IDLE_MINS}m`);

  process.on('SIGTERM', () => {
    console.log('[Guernsey Live] SIGTERM received, cleaning up...');
    clearTimers();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    console.log('[Guernsey Live] SIGINT received, cleaning up...');
    clearTimers();
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    console.error('[Guernsey Live] Uncaught exception:', err);
    clearTimers();
    sendAlert('guernsey-scraper', 'critical', 'Uncaught exception', err).finally(() => process.exit(1));
  });

  // Ensure at least 10 days of prior history exist before entering the live loop
  await ensureRecentHistory();

  // Schedule wall-clock prefetch slots at 00:00, 06:00, 12:00, 18:00 GY local
  schedulePrefetchSlot();

  // Schedule periodic timezone offset check to detect drift early
  scheduleTzCheck();

  const currentHour = guernseyHour();
  const earlyMorningCutoff = 5;
  const isInSleepWindow = currentHour >= CUTOFF_HOUR || currentHour < earlyMorningCutoff;

  if (isInSleepWindow) {
    console.log(`[Guernsey Live] Startup during sleep window (Guernsey hour: ${currentHour}) — going straight to sleep state`);
    await scheduleNextScrape();
  } else {
    const elapsed = await msSinceLastScrape('guernsey_live');
    const { ms: nextMs } = await computeNextInterval(guernseyDateStr(), mins(INTERVAL_HIGH_MINS), mins(INTERVAL_MEDIUM_MINS), mins(INTERVAL_LOW_MINS), mins(INTERVAL_IDLE_MINS));

    if (elapsed === Infinity) {
      console.log('[Guernsey Live] No previous scrape found — running immediately');
      await runLiveScrape(true);
    } else if (elapsed < nextMs) {
      const waitMs = nextMs - elapsed;
      console.log(
        `[Guernsey Live] Last scrape was ${Math.round(elapsed / 1000)}s ago — ` +
        `within current interval (${Math.round(nextMs / 1000)}s). ` +
        `Resuming in ~${Math.round(waitMs / 1000)}s`,
      );
      await new Promise(r => setTimeout(r, waitMs));
      await runLiveScrape(true);
    } else {
      console.log(
        `[Guernsey Live] Last scrape was ${Math.round(elapsed / 1000)}s ago — running immediately`,
      );
      await runLiveScrape(true);
    }

    await scheduleNextScrape();
  }
}
