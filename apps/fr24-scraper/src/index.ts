import { loadEnv, CircuitBreaker, createCircuitBreakerFromEnv, TERMINAL_STATUSES, isTerminalStatus, mins, guernseyHour, guernseyTomorrowStr, nextGuernseyTime, type TimerState } from '@airways/common';
import { scrapeOnce, guernseyDateStr } from './scraper';
import { db, scraperLogs, flights, flightTimes, tryAcquireServiceLock, clearAllTimers, countFlightsForDate, getActiveFlightsToday, getEstimatedTimesBatch, msSinceLastScrape, logSchedulerEvent, computeNextInterval, shouldSleep, computeWakeTime } from '@airways/database';
import { sendAlert } from '@airways/telegram';
import { eq, and, not, inArray, desc, count, max, asc, isNull, sql } from 'drizzle-orm';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';

loadEnv({ serviceName: 'FR24', startDir: __dirname });

// Fail fast if the process timezone is not UTC — pg serialization of
// Date objects depends on it for `timestamp without time zone` columns.
if (new Date().getTimezoneOffset() !== 0) {
  console.error(
    `[FR24] FATAL: Process timezone offset is ${new Date().getTimezoneOffset()} minutes, expected 0 (UTC). Set TZ=UTC.`,
  );
  process.exit(1);
}
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CUTOFF_HOUR          = parseInt(process.env.SCRAPER_CUTOFF_HOUR           || '23', 10);
const WAKE_OFFSET_MINS     = parseInt(process.env.SCRAPER_WAKE_OFFSET_MINS       || '30', 10);
const INTERVAL_HIGH_MS     = mins(parseInt(process.env.SCRAPER_INTERVAL_HIGH_MINS   || '2',  10));
const INTERVAL_MEDIUM_MS   = mins(parseInt(process.env.SCRAPER_INTERVAL_MEDIUM_MINS || '5',  10));
const INTERVAL_LOW_MS      = mins(parseInt(process.env.SCRAPER_INTERVAL_LOW_MINS    || '10', 10));
const INTERVAL_IDLE_MS     = mins(parseInt(process.env.SCRAPER_INTERVAL_IDLE_MINS   || '15', 10));

// ---------------------------------------------------------------------------
// State Management & Circuit Breaker
// ---------------------------------------------------------------------------

const timers: TimerState = {
  scrapeTimeout: null,
  wakeTimeout: null,
};

const circuitBreaker = createCircuitBreakerFromEnv('FR24', 5, 60000);

const clearTimers = () => clearAllTimers(timers);

function checkCircuitBreaker(): boolean {
  return circuitBreaker.check();
}

function recordFailure(): void {
  circuitBreaker.recordFailure();
}

function recordSuccess(): void {
  circuitBreaker.recordSuccess();
}

// ---------------------------------------------------------------------------
// Registration propagation — after FR24 writes a registration to any flight,
// chain it forward/backward through the day's schedule so adjacent flights
// operated by the same aircraft also get the registration.
// ---------------------------------------------------------------------------

async function propagateRegistration(
  registration: string,
  aircraftType: string | null,
  anchorFlightId: number,
): Promise<number> {
  const [anchor] = await db
    .select({
      id: flights.id,
      departureAirport: flights.departureAirport,
      arrivalAirport: flights.arrivalAirport,
      scheduledDeparture: flights.scheduledDeparture,
      scheduledArrival: flights.scheduledArrival,
      flightDate: flights.flightDate,
    })
    .from(flights)
    .where(eq(flights.id, anchorFlightId));

  if (!anchor) return 0;

  const unregistered = await db
    .select({
      id: flights.id,
      departureAirport: flights.departureAirport,
      arrivalAirport: flights.arrivalAirport,
      scheduledDeparture: flights.scheduledDeparture,
      scheduledArrival: flights.scheduledArrival,
    })
    .from(flights)
    .where(
      and(
        eq(flights.airlineCode, 'GR'),
        eq(flights.flightDate, anchor.flightDate),
        isNull(flights.aircraftRegistration),
      ),
    )
    .orderBy(asc(flights.scheduledDeparture));

  if (unregistered.length === 0) return 0;

  const matched: number[] = [];

  // Walk forward: anchor arrives at X → find next flight departing from X
  let currentArrival = anchor.arrivalAirport;
  let currentArrivalTime = anchor.scheduledArrival;
  for (const f of unregistered) {
    if (
      f.departureAirport === currentArrival &&
      f.scheduledDeparture >= currentArrivalTime
    ) {
      matched.push(f.id);
      currentArrival = f.arrivalAirport;
      currentArrivalTime = f.scheduledArrival;
    }
  }

  // Walk backward: anchor departs from Y → find previous flight arriving at Y
  let currentDeparture = anchor.departureAirport;
  let currentDepartureTime = anchor.scheduledDeparture;
  for (let i = unregistered.length - 1; i >= 0; i--) {
    const f = unregistered[i];
    if (
      f.arrivalAirport === currentDeparture &&
      f.scheduledArrival <= currentDepartureTime
    ) {
      matched.push(f.id);
      currentDeparture = f.departureAirport;
      currentDepartureTime = f.scheduledDeparture;
    }
  }

  if (matched.length === 0) return 0;

  const updateSet: Record<string, unknown> = {
    aircraftRegistration: registration,
    updatedAt: new Date(),
  };
  if (aircraftType) updateSet.aircraftType = aircraftType;

  for (const flightId of matched) {
    await db
      .update(flights)
      .set(updateSet)
      .where(and(eq(flights.id, flightId), isNull(flights.aircraftRegistration)));
  }

  return matched.length;
}

async function propagateRegistrationsForToday(): Promise<void> {
  const today = guernseyDateStr();

  const anchors = await db
    .select({
      id: flights.id,
      aircraftRegistration: flights.aircraftRegistration,
      aircraftType: flights.aircraftType,
    })
    .from(flights)
    .where(
      and(
        eq(flights.airlineCode, 'GR'),
        eq(flights.flightDate, today),
        sql`${flights.aircraftRegistration} IS NOT NULL`,
      ),
    )
    .orderBy(asc(flights.scheduledDeparture));

  if (anchors.length === 0) return;

  const seen = new Set<string>();
  let totalPropagated = 0;

  for (const a of anchors) {
    if (seen.has(a.aircraftRegistration!)) continue;
    seen.add(a.aircraftRegistration!);
    const count = await propagateRegistration(
      a.aircraftRegistration!,
      a.aircraftType,
      a.id,
    );
    totalPropagated += count;
  }

  if (totalPropagated > 0) {
    console.log(`[FR24] Propagated registrations to ${totalPropagated} additional flight(s)`);
  }
}

async function runScrape(label: string): Promise<void> {
  const result = await scrapeOnce();
  if (!result.success) {
    console.error(`[FR24] ${label} failed: ${result.error}`);
  } else {
    console.log(`[FR24] ${label} complete — ${result.count} flights upserted`);
    // After a successful scrape, propagate any registrations FR24 wrote
    await propagateRegistrationsForToday();
  }
}

async function scheduleNextScrape(): Promise<void> {
  const todayStr = guernseyDateStr();
  const { sleep, reason } = await shouldSleep(todayStr, CUTOFF_HOUR, guernseyHour());

  if (sleep) {
    await logSchedulerEvent('fr24_live', 'sleep', reason);

    const { wakeAt, reason: wakeReason } = await computeWakeTime(todayStr, guernseyTomorrowStr(), guernseyHour(), CUTOFF_HOUR, WAKE_OFFSET_MINS);
    const sleepMs = Math.max(0, wakeAt.getTime() - Date.now());

    await logSchedulerEvent('fr24_live', 'sleep', `Sleeping for ${Math.round(sleepMs / 60_000)}m. ${wakeReason}`);
    console.log(`[FR24] Setting wake timeout: will fire in ${Math.round(sleepMs / 1000)}s at ${wakeAt.toISOString()}`);

    timers.wakeTimeout = setTimeout(async () => {
      try {
        timers.wakeTimeout = null;
        await logSchedulerEvent('fr24_live', 'wake', `Waking up — ${wakeReason}`);
        await runScrape('Post-sleep scrape');
        await scheduleNextScrape();
      } catch (err) {
        console.error('[FR24] Error in wake timeout callback:', err);
        sendAlert('fr24-scraper', 'warning', 'Wake timeout callback error', err).catch(() => {});
        timers.wakeTimeout = null;
        try {
          await scheduleNextScrape();
        } catch (err2) {
          console.error('[FR24] Fatal: Failed to reschedule after wake error:', err2);
          sendAlert('fr24-scraper', 'critical', 'Failed to reschedule after wake error — scheduler may be stuck', err2).catch(() => {});
          timers.wakeTimeout = setTimeout(() => {
            timers.wakeTimeout = null;
            scheduleNextScrape().catch(e => console.error('[FR24] Fatal retry failed:', e));
          }, 5 * 60 * 1000);
        }
      }
    }, sleepMs);

    return;
  }

  const { ms, jitterMs, reason: intervalReason } = await computeNextInterval(guernseyDateStr(), INTERVAL_HIGH_MS, INTERVAL_MEDIUM_MS, INTERVAL_LOW_MS, INTERVAL_IDLE_MS);
  const totalMs = ms + jitterMs;

  console.log(
    `[FR24] Next scrape in ${Math.round(ms / 1000)}s + ${Math.round(jitterMs / 1000)}s jitter = ${Math.round(totalMs / 1000)}s. Reason: ${intervalReason}`,
  );

  if (timers.scrapeTimeout) {
    clearTimeout(timers.scrapeTimeout);
    timers.scrapeTimeout = null;
  }

  timers.scrapeTimeout = setTimeout(async () => {
    timers.scrapeTimeout = null;

    if (!circuitBreaker.check()) {
      console.log('[FR24] Circuit breaker open, skipping scrape and rescheduling');
      await scheduleNextScrape();
      return;
    }

    try {
      await runScrape('Scheduled scrape');
      circuitBreaker.recordSuccess();
    } catch (err) {
      console.error('[FR24] Error in scheduled scrape:', err);
      sendAlert('fr24-scraper', 'warning', 'Scheduled scrape error', err).catch(() => {});
      recordFailure();
    }
    await scheduleNextScrape();
  }, totalMs);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  // Prevent duplicate instances via PostgreSQL advisory lock.
  // If another fr24_live process already holds the lock, exit immediately.
  const acquired = await tryAcquireServiceLock('fr24_live');
  if (!acquired) {
    console.log('[FR24] Another instance is already running (lock held). Exiting.');
    process.exit(0);
  }

  console.log('[FR24] Scraper service starting...');
  console.log(`[FR24] Config — cutoff: ${CUTOFF_HOUR}:00 GY, wake offset: ${WAKE_OFFSET_MINS}m`);
  console.log(`[FR24] Intervals — high: ${INTERVAL_HIGH_MS / 1000}s, medium: ${INTERVAL_MEDIUM_MS / 1000}s, low: ${INTERVAL_LOW_MS / 1000}s, idle: ${INTERVAL_IDLE_MS / 1000}s`);

  const currentHour = guernseyHour();
  const earlyMorningCutoff = 5;
  const isInSleepWindow = currentHour >= CUTOFF_HOUR || currentHour < earlyMorningCutoff;

  if (isInSleepWindow) {
    console.log(`[FR24] Startup during sleep window (Guernsey hour: ${currentHour}) — going straight to sleep state`);
    await scheduleNextScrape();
  } else {
    const elapsed = await msSinceLastScrape('fr24_live');
    const { ms: nextMs } = await computeNextInterval(guernseyDateStr(), INTERVAL_HIGH_MS, INTERVAL_MEDIUM_MS, INTERVAL_LOW_MS, INTERVAL_IDLE_MS);

    if (elapsed === Infinity) {
      console.log('[FR24] No previous scrape found — running immediately');
      await runScrape('Initial scrape');
    } else if (elapsed < nextMs) {
      const waitMs = nextMs - elapsed;
      console.log(
        `[FR24] Last scrape was ${Math.round(elapsed / 1000)}s ago — ` +
        `within current interval (${Math.round(nextMs / 1000)}s). ` +
        `Resuming in ~${Math.round(waitMs / 1000)}s`,
      );
      await new Promise(r => setTimeout(r, waitMs));
      await runScrape('Resume scrape');
    } else {
      console.log(
        `[FR24] Last scrape was ${Math.round(elapsed / 1000)}s ago — running immediately`,
      );
      await runScrape('Initial scrape');
    }

    await scheduleNextScrape();
  }
}

process.on('SIGTERM', () => {
  console.log('[FR24] SIGTERM received, cleaning up...');
  clearTimers();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[FR24] SIGINT received, cleaning up...');
  clearTimers();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[FR24] Uncaught exception:', err);
  clearTimers();
  sendAlert('fr24-scraper', 'critical', 'Uncaught exception', err).finally(() => process.exit(1));
});

main().catch(err => {
  console.error('[FR24] Fatal startup error:', err);
  clearTimers();
  sendAlert('fr24-scraper', 'critical', 'Fatal startup error', err).finally(() => process.exit(1));
});
