/**
 * Shared scheduler logic for periodic scrapers.
 *
 * Both guernsey-scraper and fr24-scraper use the same DB-driven
 * scheduling pattern: dynamic intervals, sleep/wake decisions,
 * timer management, and scraper log event recording.
 */
import { eq, and, not, inArray, asc, count, desc, max, sql } from 'drizzle-orm';
import { flights, flightTimes, scraperLogs } from './schema';
import { db } from './index';

/** Timer state for scheduler implementations */
export interface TimerState {
  scrapeTimeout: ReturnType<typeof setTimeout> | null;
  wakeTimeout: ReturnType<typeof setTimeout> | null;
  prefetchSlotTimeout?: ReturnType<typeof setTimeout> | null;
  tzCheckTimeout?: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function clearAllTimers(timers: TimerState): void {
  for (const key of Object.keys(timers)) {
    const k = key as keyof TimerState;
    if (timers[k]) {
      clearTimeout(timers[k]!);
      timers[k] = null;
    }
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export async function countFlightsForDate(dateStr: string): Promise<number> {
  try {
    const [{ value }] = await db
      .select({ value: count() })
      .from(flights)
      .where(eq(flights.flightDate, dateStr));
    return value ?? 0;
  } catch {
    return 0;
  }
}

export async function getActiveFlightsToday(
  todayStr: string,
): Promise<
  Array<{
    id: number;
    flightNumber: string;
    scheduledDeparture: Date | null;
    scheduledArrival: Date | null;
    actualDeparture: Date | null;
    actualArrival: Date | null;
    status: string | null;
  }>
> {
  return db
    .select({
      id: flights.id,
      flightNumber: flights.flightNumber,
      scheduledDeparture: flights.scheduledDeparture,
      scheduledArrival: flights.scheduledArrival,
      actualDeparture: flights.actualDeparture,
      actualArrival: flights.actualArrival,
      status: flights.status,
    })
    .from(flights)
    .where(
      and(
        eq(flights.flightDate, todayStr),
        eq(flights.canceled, false),
        // Exclude terminal and diverted statuses
        not(inArray(flights.status, ['Landed', 'Cancelled'])),
        sql`(${flights.status} IS NULL OR LOWER(${flights.status}) NOT LIKE 'diverted%')`,
      ),
    );
}

export async function getEstimatedTimesBatch(
  flightIds: number[],
): Promise<Map<number, { estDep?: Date; estArr?: Date }>> {
  const result = new Map<number, { estDep?: Date; estArr?: Date }>();
  if (flightIds.length === 0) return result;
  try {
    const rows = await db
      .select({
        flightId: flightTimes.flightId,
        timeType: flightTimes.timeType,
        timeValue: flightTimes.timeValue,
      })
      .from(flightTimes)
      .where(
        and(
          inArray(flightTimes.flightId, flightIds),
          inArray(flightTimes.timeType, ['EstimatedBlockOff', 'EstimatedBlockOn']),
        ),
      );
    for (const row of rows) {
      const entry = result.get(row.flightId) ?? {};
      if (row.timeType === 'EstimatedBlockOff') entry.estDep = new Date(row.timeValue);
      if (row.timeType === 'EstimatedBlockOn') entry.estArr = new Date(row.timeValue);
      result.set(row.flightId, entry);
    }
  } catch {
    // Return empty map on error
  }
  return result;
}

export async function msSinceLastScrape(serviceName: string): Promise<number> {
  try {
    const [last] = await db
      .select({ completedAt: scraperLogs.completedAt })
      .from(scraperLogs)
      .where(eq(scraperLogs.service, serviceName as any))
      .orderBy(desc(scraperLogs.completedAt))
      .limit(1);
    if (!last?.completedAt) return Infinity;
    return Date.now() - new Date(last.completedAt).getTime();
  } catch {
    return Infinity;
  }
}

// ---------------------------------------------------------------------------
// Scheduler event logger
// ---------------------------------------------------------------------------

export async function logSchedulerEvent(
  serviceName: string,
  type: 'sleep' | 'wake' | 'prefetch',
  detail: string,
): Promise<void> {
  try {
    const label = type === 'sleep' ? 'SLEEP' : type === 'wake' ? 'WAKE' : 'PREFETCH';
    await db.insert(scraperLogs).values({
      service: serviceName as any,
      status: 'success',
      recordsScraped: 0,
      errorMessage: `[${label}] ${detail}`,
      eventType: type,
      startedAt: new Date(),
      completedAt: new Date(),
    });
    console.log(`[${serviceName}] [${label}] ${detail}`);
  } catch (err) {
    console.error(`[${serviceName}] Failed to write scheduler event to DB:`, err);
  }
}

// ---------------------------------------------------------------------------
// Dynamic interval calculation (4-tier)
// ---------------------------------------------------------------------------

export async function computeNextInterval(
  todayStr: string,
  intervalHighMs: number,
  intervalMediumMs: number,
  intervalLowMs: number,
  intervalIdleMs: number,
): Promise<{ ms: number; jitterMs: number; reason: string }> {
  const activeFlights = await getActiveFlightsToday(todayStr);

  if (activeFlights.length === 0) {
    return {
      ms: intervalIdleMs,
      jitterMs: Math.floor(Math.random() * 90_000),
      reason: 'No active flights today — idle frequency',
    };
  }

  const now = Date.now();
  let soonestEventMs = Infinity;
  let soonestFlight = '';

  const estimatedTimesMap = await getEstimatedTimesBatch(activeFlights.map((f) => f.id));

  for (const f of activeFlights) {
    const { estDep, estArr } = estimatedTimesMap.get(f.id) ?? {};
    let nextEventMs: number | null = null;

    if (!f.actualDeparture) {
      const depTime = estDep ?? f.scheduledDeparture;
      if (depTime) nextEventMs = new Date(depTime).getTime();
    } else if (!f.actualArrival) {
      const arrTime = estArr ?? f.scheduledArrival;
      if (arrTime) nextEventMs = new Date(arrTime).getTime();
    }

    if (nextEventMs !== null && nextEventMs < soonestEventMs) {
      soonestEventMs = nextEventMs;
      soonestFlight = f.flightNumber;
    }
  }

  if (soonestEventMs === Infinity) {
    return {
      ms: intervalIdleMs,
      jitterMs: Math.floor(Math.random() * 90_000),
      reason: `${activeFlights.length} active flight(s) but no upcoming event times found — idle frequency`,
    };
  }

  const minsUntil = (soonestEventMs - now) / 60_000;

  const highLabel = `high frequency (${Math.round(intervalHighMs / 1000)}s)`;
  const mediumLabel = `medium frequency (${Math.round(intervalMediumMs / 1000)}s)`;
  const lowLabel = `low frequency (${Math.round(intervalLowMs / 1000)}s)`;
  const idleLabel = `idle frequency (${Math.round(intervalIdleMs / 1000)}s)`;

  if (minsUntil < 20) {
    return { ms: intervalHighMs, jitterMs: Math.floor(Math.random() * 15_000), reason: `${minsUntil.toFixed(0)}m until ${soonestFlight} event — ${highLabel}` };
  }
  if (minsUntil < 60) {
    return { ms: intervalMediumMs, jitterMs: Math.floor(Math.random() * 30_000), reason: `${minsUntil.toFixed(0)}m until ${soonestFlight} event — ${mediumLabel}` };
  }
  if (minsUntil < 120) {
    return { ms: intervalLowMs, jitterMs: Math.floor(Math.random() * 60_000), reason: `${minsUntil.toFixed(0)}m until ${soonestFlight} event — ${lowLabel}` };
  }
  return { ms: intervalIdleMs, jitterMs: Math.floor(Math.random() * 90_000), reason: `${minsUntil.toFixed(0)}m until ${soonestFlight} event — ${idleLabel}` };
}

// ---------------------------------------------------------------------------
// Sleep / wake decision
// ---------------------------------------------------------------------------

export async function shouldSleep(
  todayStr: string,
  cutoffHour: number,
  currentHour: number,
): Promise<{ sleep: boolean; reason: string }> {
  if (currentHour >= cutoffHour) {
    return {
      sleep: true,
      reason: `Hard cutoff — Guernsey local hour ${currentHour} >= ${cutoffHour}`,
    };
  }

  const totalToday = await countFlightsForDate(todayStr);

  if (totalToday === 0) {
    return { sleep: false, reason: '' };
  }

  const activeFlights = await getActiveFlightsToday(todayStr);
  if (activeFlights.length === 0) {
    try {
      const [{ lastUpdate }] = await db
        .select({ lastUpdate: max(flights.updatedAt) })
        .from(flights)
        .where(eq(flights.flightDate, todayStr));

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      if (!lastUpdate || new Date(lastUpdate) < twoHoursAgo) {
        return {
          sleep: false,
          reason: `All flights appear terminal but data is stale (last update: ${lastUpdate ?? 'never'}) — scraping to refresh`,
        };
      }
    } catch {
      return { sleep: false, reason: 'Could not verify data freshness — staying active' };
    }

    return {
      sleep: true,
      reason: `All ${totalToday} flights for ${todayStr} are in terminal status`,
    };
  }

  return { sleep: false, reason: '' };
}

// ---------------------------------------------------------------------------
// Wake time calculation
// ---------------------------------------------------------------------------

export async function computeWakeTime(
  todayStr: string,
  tomorrowStr: string,
  currentHour: number,
  cutoffHour: number,
  wakeOffsetMins: number,
): Promise<{ wakeAt: Date; reason: string }> {
  const now = new Date();

  // Step 1: check TODAY first
  if (currentHour < cutoffHour) {
    try {
      const activeToday = await getActiveFlightsToday(todayStr);
      if (activeToday.length > 0) {
        const upcoming = activeToday
          .filter((f) => f.scheduledDeparture != null)
          .map((f) => new Date(f.scheduledDeparture!).getTime())
          .filter((t) => t > now.getTime())
          .sort((a, b) => a - b);

        if (upcoming.length > 0) {
          const wakeAt = new Date(upcoming[0] - wakeOffsetMins * 60_000);
          if (wakeAt > now) {
            return {
              wakeAt,
              reason: `${wakeOffsetMins}m before next flight on ${todayStr}`,
            };
          }
          return { wakeAt: now, reason: `Active flights on ${todayStr} need tracking — waking now` };
        }
        return { wakeAt: now, reason: `Airborne flights on ${todayStr} need tracking — waking now` };
      }
    } catch (err) {
      console.error('[scheduler] Error querying today flights for wake time:', err);
    }
  }

  // Step 2: look at tomorrow
  const totalTomorrow = await countFlightsForDate(tomorrowStr);
  if (totalTomorrow > 0) {
    try {
      const [firstFlight] = await db
        .select({ scheduledDeparture: flights.scheduledDeparture })
        .from(flights)
        .where(and(eq(flights.flightDate, tomorrowStr), eq(flights.canceled, false)))
        .orderBy(asc(flights.scheduledDeparture))
        .limit(1);

      if (firstFlight?.scheduledDeparture) {
        const wakeAt = new Date(new Date(firstFlight.scheduledDeparture).getTime() - wakeOffsetMins * 60_000);
        if (wakeAt > now) {
          return { wakeAt, reason: `${wakeOffsetMins}m before first flight on ${tomorrowStr}` };
        }
      }
    } catch (err) {
      console.error('[scheduler] Error querying first flight for wake time:', err);
    }
  }

  // Step 3: Fallback — 05:00 Guernsey tomorrow (caller computes this)
  return { wakeAt: now, reason: 'No tomorrow schedule — caller should fall back to 05:00 Guernsey' };
}
