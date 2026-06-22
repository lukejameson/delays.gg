import * as cheerio from 'cheerio';
import { db, flights, flightStatusHistory, flightTimes, scraperLogs, canUpgradeStatus, routeFlightMinutes, locationToIata, localToUtc, guernseyTodayStr } from '@airways/database';
import { eq, and, isNull, sql, count, or, isNotNull } from 'drizzle-orm';

interface StatusUpdate {
  flightCode: string;
  flightDate: string; // YYYY-MM-DD
  statusTimestamp: Date;
  statusMessage: string;
}

interface ScrapedFlight {
  location: string;
  codes: string[]; // may be multiple for codeshare flights e.g. "GR670, LM670"
  scheduledTime: Date;
  flightDate: string; // YYYY-MM-DD
  type: 'arrivals' | 'departures';
  statusUpdates: StatusUpdate[];
}







const BASE_URL = process.env.GUERNSEY_AIRPORT_URL || 'https://www.airport.gg';
const API_URL = process.env.GUERNSEY_API_URL || 'https://www.airport.gg/arr-dep/json';
function getApiKey(): string {
  const key = process.env.GUERNSEY_API_KEY;
  if (!key) throw new Error('GUERNSEY_API_KEY environment variable is required');
  return key;
}

interface ApiFlightEntry {
  flight_time: string;
  flight_comment: string;
  flight_date: string;
  last_updated: string;
  flight_numbers: string[];
  flight_locations: string[];
  airlines: string[];
}

interface ApiResponse {
  arrivals: ApiFlightEntry[];
  departures: ApiFlightEntry[];
}

async function fetchApiData(): Promise<ApiResponse> {
  const url = `${API_URL}?key=${getApiKey()}`;
  console.log(`[Guernsey] Fetching API data → ${API_URL}`);
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from Guernsey API`);
  }
  return response.json() as Promise<ApiResponse>;
}

function mapApiEntriesToScrapedFlights(
  entries: ApiFlightEntry[],
  type: 'arrivals' | 'departures',
  filterDate?: string,
): ScrapedFlight[] {
  const results: ScrapedFlight[] = [];
  for (const entry of entries) {
    if (filterDate && entry.flight_date !== filterDate) continue;
    if (!entry.flight_numbers || entry.flight_numbers.length === 0) continue;

    const timeParts = entry.flight_time.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeParts) continue;
    const hh = parseInt(timeParts[1]);
    const mm = parseInt(timeParts[2]);
    const scheduledTime = localToUtc(entry.flight_date, hh, mm);

    const location = entry.flight_locations.join(', ');
    const codes = entry.flight_numbers;
    const statusUpdates: StatusUpdate[] = [];

    if (entry.flight_comment) {
      const lastUpdated = parseInt(entry.last_updated, 10);
      const statusTimestamp = isNaN(lastUpdated) ? new Date() : new Date(lastUpdated * 1000);
      for (const flightCode of codes) {
        statusUpdates.push({
          flightCode,
          flightDate: entry.flight_date,
          statusTimestamp,
          statusMessage: entry.flight_comment,
        });
      }
    }

    results.push({
      location,
      codes,
      scheduledTime,
      flightDate: entry.flight_date,
      type,
      statusUpdates,
    });
  }
  return results;
}
function airlineCode(flightCode: string): string {
  const match = flightCode.match(/^([A-Z]{2})/);
  const code = match ? match[1] : 'XX';
  if (code === 'SI' || code === 'AT') return 'GR';
  return code;
}

async function fetchDayHtml(date: Date): Promise<string> {
  // airport.gg uses DDMMYYYY in the URL path under /arrivals-departures/history/
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const formattedDate = `${day}${month}${year}`;

  const url = `${BASE_URL}/arrivals-departures/history/${formattedDate}`;
  const dateStr = `${year}-${month}-${day}`;

  console.log(`[Guernsey] Fetching ${dateStr} → ${url}`);

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.5',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

function parseFlightHtml(html: string, date: Date, type: 'arrivals' | 'departures'): ScrapedFlight[] {
  const $ = cheerio.load(html);
  const tableId = type === 'arrivals' ? '#table-arrivals' : '#table-departures';

  const results: ScrapedFlight[] = [];
  const defaultFlightDate = guernseyTodayStr(date);

  $(`${tableId} tbody.list tr[data-search="true"]`).each((_, row) => {
    try {
      const $row = $(row);

      const timeStr = $row.find('td.time').text().trim();
      const [hh, mm] = timeStr.split(':').map(Number);

      if (isNaN(hh) || isNaN(mm)) return;

      // If the row has an explicit date cell (airport.gg shows tomorrow's flights on today's
      // page with a visible date), use that date; otherwise fall back to the page's date.
      let flightDate = defaultFlightDate;
      let rowDate = date;
      const dateCellText = $row.find('td.date').text().trim();
      if (dateCellText) {
        const dateMatch = dateCellText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (dateMatch) {
          const [, d, mo, y] = dateMatch;
          flightDate = `${y}-${mo}-${d}`;
          rowDate = new Date(`${flightDate}T00:00:00Z`);
        }
      }

      const scheduledTime = localToUtc(flightDate, hh, mm);

      const location = $row.find('td.airport').text().trim();

      // Codeshare rows show multiple codes separated by commas e.g. "GR670, LM670"
      // Split and trim each, keep only non-empty codes within varchar(20) limit
      const codes = $row.find('td.flight').text().trim()
        .split(',')
        .map(c => c.trim())
        .filter(c => c.length > 0 && c.length <= 20);

      if (codes.length === 0) return;

      const statusUpdates: StatusUpdate[] = [];

      // Each status update has a separate span.datetime and span.comment
      // e.g. <span class="datetime">23/02/2026 09:16:</span> <span class="comment">Delayed To 10:40</span>
      $row.find('td.status div.status-change').each((_, div) => {
        const datetimeRaw = $(div).find('span.datetime').text().trim();
        const comment = $(div).find('span.comment').text().trim();

        if (!comment) return;

        // Parse "DD/MM/YYYY HH:MM:" from the dedicated datetime span
        const tsMatch = datetimeRaw.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
        if (tsMatch) {
          const [, d, mo, y, h, mi] = tsMatch;
          const dateStr = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const statusTimestamp = localToUtc(dateStr, parseInt(h), parseInt(mi));
          if (!isNaN(statusTimestamp.getTime())) {
            for (const flightCode of codes) {
              statusUpdates.push({ flightCode, flightDate, statusTimestamp, statusMessage: comment });
            }
          }
          return;
        }

        // Fallback: no parseable datetime — use time of scrape
        for (const flightCode of codes) {
          statusUpdates.push({
            flightCode,
            flightDate,
            statusTimestamp: new Date(),
            statusMessage: comment,
          });
        }
      });

      results.push({ location, codes, scheduledTime, flightDate, type, statusUpdates });
    } catch (err) {
      console.error('[Guernsey] Error parsing row:', err);
    }
  });
  return results;
}
/**
 * Extract hours and minutes from a time string.
 * Handles both "HH:MM" (e.g. "12:10") and "HHMM" (e.g. "1210") formats,
 * since airport.gg inconsistently uses both.
 */
function parseHHMM(text: string): { hh: number; mm: number } | null {
  // Try colon-separated first: "12:10", "9:05"
  const colonMatch = text.match(/(\d{1,2}):(\d{2})/);
  if (colonMatch) return { hh: parseInt(colonMatch[1]), mm: parseInt(colonMatch[2]) };
  // Try 4-digit no-colon: "1210", "0905" — only match standalone 4-digit groups
  // to avoid matching dates or other numbers.
  const noColonMatch = text.match(/(?<!\d)(\d{2})(\d{2})(?!\d)/);
  if (noColonMatch) {
    const hh = parseInt(noColonMatch[1]);
    const mm = parseInt(noColonMatch[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return { hh, mm };
  }
  return null;
}

/**
 * Extract the most relevant ETD from a delay-bearing status message.
 *
 * Messages like "Flight Delayed. Check in opens 16:00 New ETD 18:30" contain
 * multiple times — the check-in opening time and the actual ETD. parseHHMM
 * would naively return 16:00 (first match). This function prefers times after
 * ETD-specific keywords ("new etd", "delayed to", etc.) over the first time
 * in the message.
 */
function parseEtdTime(msg: string): { hh: number; mm: number } | null {
  const lower = msg.toLowerCase();

  // ETD-specific keywords — extract time from the portion AFTER the keyword.
  // Order matters: check "new etd" before "delayed" because a message like
  // "Flight Delayed. Check in opens 16:00 New ETD 18:30" matches both.
  for (const keyword of ['new etd', 'delayed until', 'delayed to', 'flight delayed to approx',
    'boarding expected', 'next info', 'expected at']) {
    const idx = lower.indexOf(keyword);
    if (idx !== -1) {
      const after = msg.slice(idx + keyword.length);
      const parsed = parseHHMM(after);
      if (parsed) return parsed;
    }
  }

  // "Approx" at the start of the message — time is right after it.
  if (lower.startsWith('approx')) {
    return parseHHMM(msg);
  }

  // Fallback: extract the first time in the message (legacy behavior).
  return parseHHMM(msg);
}

/**
 * Parse an HH:MM or HHMM time from a status message and return it as a Date
 * on the same day as the reference date, or null if no time found.
 */
function parseTimeFromMessage(message: string, referenceDate: Date): Date | null {
  const parsed = parseHHMM(message);
  if (!parsed) return null;
  const refDateStr = referenceDate.toISOString().split('T')[0];
  return localToUtc(refDateStr, parsed.hh, parsed.mm);
}

/**
 * Derive a normalised status string from status updates.
 * Maps raw airport.gg messages to a normalised vocabulary:
 * Scheduled, On Time, Boarding, Delayed, Airborne, Landed, Cancelled.
 *
 * Priority: scan ALL updates for terminal statuses first (landed/airborne/cancelled),
 * then derive from the most recent update.
 *
 * For "Approx HH:MM" messages, compares the time against scheduledTime to determine
 * whether the flight is actually delayed, on time, or early.
 */
function deriveStatus(updates: StatusUpdate[], scheduledTime: Date): string | null {
  if (updates.length === 0) return null;

  // Scan all updates for terminal/important statuses (latest wins).
  // Ignore Airborne/Landed messages posted more than 30 minutes before the
  // scheduled time — they are stale data from a previous rotation on the board.
  const preScheduleCutoff = scheduledTime.getTime() - 30 * 60_000;
  for (let i = updates.length - 1; i >= 0; i--) {
    const msg = updates[i].statusMessage.toLowerCase();
    const isPreSchedule = updates[i].statusTimestamp.getTime() < preScheduleCutoff;
    if (msg.includes('landed') || msg.includes('voyagereported')) {
      if (!isPreSchedule) return 'Landed';
    } else if (msg.includes('airborne')) {
      if (!isPreSchedule) return 'Airborne';
    } else if (msg.includes('diverted') || msg.includes('diverting')) {
      return 'Diverted';
    }
  }

  // Now check the latest update for non-terminal statuses
  const last = updates[updates.length - 1].statusMessage.toLowerCase();
  if (last.includes('cancelled') || last.includes('canceled') || last.includes('flight cancelled')) return 'Cancelled';

  // For "Approx HH:MM" without an explicit "delayed" keyword, compare the time
  // to the scheduled time — it might be on time or even early.
  if (last.includes('approx') && !last.includes('delayed')) {
    const approxTime = parseTimeFromMessage(updates[updates.length - 1].statusMessage, scheduledTime);
    if (approxTime) {
      const diffMs = approxTime.getTime() - scheduledTime.getTime();
      const diffMins = Math.round(diffMs / 60_000);
      // Allow a 5-minute tolerance — anything within 5 mins of scheduled is "on time"
      if (diffMins <= 5) return 'Scheduled';
      return 'Delayed';
    }
    // No time in the message — fall through to generic delay handling
  }

  // Delay indicators: "Flight Delayed", "Delayed To HH:MM", "Expected at HH:MM",
  // "New ETD HH:MM", "Next Info HH:MM", "Indefinite Delay", "Boarding Expected HH:MM"
  if (last.includes('delayed') || last.includes('expected at') ||
      last.includes('new etd') || last.includes('next info') || last.includes('indefini') ||
      last.includes('boarding expected')) return 'Delayed';
  // Check-in phase — distinct from Boarding (passengers aren't at the gate yet)
  if (last.includes('check in open') || last.includes('check-in open') ||
      last.includes('go to departure')) return 'Check-In Open';
  // Boarding-related: "Final Call", "Go To Door/Gate", "Door and Gate Closed",
  // "Wait In Lounge"
  if (last.includes('final call') || last.includes('go to door') || last.includes('go to gate') ||
      last.includes('gate closed') || last.includes('door and gate') ||
      last.includes('wait in lounge')) return 'Boarding';
  if (last.includes('check in suspended') || last.includes('check in closes') ||
      last.includes('check-in closes') || last.includes('check in opens')) return 'Delayed';
  if (last.includes('holding overhead') || last.includes('holding in')) return 'Airborne';
  if (last.includes('on time')) return 'Scheduled';
  if (last.includes('pax on') || last.includes('pax from') || last.includes('passengers on') ||
      last.includes('passengers from')) return 'Scheduled';

  // Return the raw message for anything truly unknown
  return updates[updates.length - 1].statusMessage;
}

/**
 * Extract actual time from status messages like "Landed 12:14" or "Airborne at 06:49".
 *
 * Uses referenceDate (the flight's scheduled time) as the base date rather than the
 * status update's timestamp. This prevents false large delays when airports.gg posts
 * "Airborne at 22:30" the following morning (e.g. 07:03 next day) — without this fix,
 * building the Date from the next-day timestamp produces a ~24-hour apparent delay.
 */
function extractActualTime(updates: StatusUpdate[], keyword: string, referenceDate: Date): Date | null {
  // Track the first matching status update as a fallback when no HH:MM is parsable
  let fallbackTimestamp: Date | null = null;

  for (let i = updates.length - 1; i >= 0; i--) {
    if (updates[i].statusMessage.toLowerCase().includes(keyword.toLowerCase())) {
      const parsed = parseHHMM(updates[i].statusMessage);
      if (parsed) {
        const refDateStr = referenceDate.toISOString().split('T')[0];
        const extracted = localToUtc(refDateStr, parsed.hh, parsed.mm);
        // Reject times more than 30 minutes before scheduled — stale data from a
        // previous rotation that the airport board hasn't cleared yet.
        if (extracted.getTime() < referenceDate.getTime() - 30 * 60_000) continue;
        return extracted;
      }
      // Keyword matched but no time in the message (e.g. plain "Landed").
      // Save the first match's timestamp as a fallback.
      if (!fallbackTimestamp) {
        fallbackTimestamp = updates[i].statusTimestamp;
      }
    }
  }

  // Fallback: use the status update timestamp if we found a keyword match
  // but no parsable HH:MM time. Reject timestamps before the reference date
  // (next-day postings of old statuses).
  if (fallbackTimestamp && fallbackTimestamp.getTime() >= referenceDate.getTime()) {
    return fallbackTimestamp;
  }

  return null;
}

/** Returns true if any status message indicates the flight was cancelled. */
function extractCanceled(updates: StatusUpdate[]): boolean {
  return updates.some(u => {
    const msg = u.statusMessage.toLowerCase();
    return msg.includes('cancelled') || msg.includes('canceled');
  });
}

/**
 * Scans status updates in reverse for time-bearing messages:
 *   - "Delayed To HH:MM"
 *   - "Approx HH:MM" (estimated arrival/departure time from the airport board)
 *
 * Returns the delay in minutes relative to scheduledTime (can be 0 for on-time,
 * negative values are clamped to 0), or null if no time-bearing message found.
 */
function extractDelayMinutes(updates: StatusUpdate[], scheduledTime: Date): number | null {
  for (let i = updates.length - 1; i >= 0; i--) {
    const msg = updates[i].statusMessage.toLowerCase();
    if (msg.includes('delayed to') || msg.startsWith('approx') || msg.includes('new etd') ||
        msg.includes('expected at') || msg.includes('delayed until') || msg.includes('boarding expected') ||
        msg.includes('flight delayed to approx') || msg.includes('next info')) {
      const parsed = parseEtdTime(updates[i].statusMessage);
      if (parsed) {
        const refDateStr = scheduledTime.toISOString().split('T')[0];
        const estimatedTime = localToUtc(refDateStr, parsed.hh, parsed.mm);
        const diffMs = estimatedTime.getTime() - scheduledTime.getTime();
        const diffMins = Math.round(diffMs / 60_000);
        if (diffMins <= 5) return 0;
        return diffMins;
      }
    }
  }
  return null;
}
function extractEstimatedTime(updates: StatusUpdate[], scheduledTime: Date): Date | null {
  for (let i = updates.length - 1; i >= 0; i--) {
    const msg = updates[i].statusMessage.toLowerCase();
    if (msg.includes('delayed to') || msg.startsWith('approx') || msg.includes('new etd') ||
        msg.includes('expected at') || msg.includes('delayed until') || msg.includes('boarding expected') ||
        msg.includes('flight delayed to approx') || msg.includes('next info')) {
      const parsed = parseEtdTime(updates[i].statusMessage);
      if (parsed) {
        const refDateStr = scheduledTime.toISOString().split('T')[0];
        return localToUtc(refDateStr, parsed.hh, parsed.mm);
      }
    }
  }
  return null;
}

/** Inserts or updates a flightTimes row keyed on (flightId, timeType). */
async function upsertFlightTime(flightId: number, timeType: string, timeValue: Date): Promise<void> {
  await db
    .insert(flightTimes)
    .values({ flightId, timeType, timeValue })
    .onConflictDoUpdate({
      target: [flightTimes.flightId, flightTimes.timeType],
      set: { timeValue },
    });
}

/**
 * Upsert a flight into the flights table and return its id.
 * Uses flight_number + flight_date as the natural key for historical data
 * (historical flights use flightNumber_date format for unique_id).
 */
async function upsertFlight(scrapedFlight: ScrapedFlight): Promise<number | null> {
  // Use the primary (first) flight code — codeshares share the same flight record
  const primaryCode = scrapedFlight.codes[0];
  const otherIata = locationToIata(scrapedFlight.location);

  const departureAirport = scrapedFlight.type === 'departures' ? 'GCI' : otherIata;
  const arrivalAirport   = scrapedFlight.type === 'departures' ? otherIata : 'GCI';

  // airport.gg shows the relevant endpoint time:
  //   departures → scheduled departure time from GCI
  //   arrivals   → scheduled arrival time at GCI
  // Use route-specific flight duration to estimate the other end.
  const flightMins = routeFlightMinutes(otherIata);
  let scheduledDeparture: Date;
  let scheduledArrival: Date;
  if (scrapedFlight.type === 'departures') {
    scheduledDeparture = scrapedFlight.scheduledTime;
    scheduledArrival   = new Date(scheduledDeparture.getTime() + flightMins * 60_000);
  } else {
    scheduledArrival   = scrapedFlight.scheduledTime;
    scheduledDeparture = new Date(scheduledArrival.getTime() - flightMins * 60_000);
  }

  const actualDeparture = scrapedFlight.type === 'departures'
    ? extractActualTime(scrapedFlight.statusUpdates, 'Airborne', scheduledDeparture)
    : null;
  const actualArrival = scrapedFlight.type === 'arrivals'
    ? extractActualTime(scrapedFlight.statusUpdates, 'Landed', scheduledArrival)
    : null;

  // Reject actual times that are impossible — an arrival before the
  // Reject actual times that are impossible — an arrival before the
  // scheduled departure means stale/cross-contaminated data (e.g. the
  // morning rotation's status bleeding into the afternoon rotation).
  // For departures after the scheduled arrival: allow up to MAX_REALISTIC_DELAY
  // (6 hours) — a delayed flight CAN depart after its scheduled arrival time.
  const sanitizedActualDeparture = (actualDeparture
    && actualDeparture.getTime() > scheduledArrival.getTime() + MAX_REALISTIC_DELAY_MINUTES * 60_000)
    ? null : actualDeparture;
  const sanitizedActualArrival = (actualArrival && actualArrival.getTime() < scheduledDeparture.getTime())
    ? null : actualArrival;

  const status = deriveStatus(scrapedFlight.statusUpdates, scrapedFlight.scheduledTime);
  const canceled = extractCanceled(scrapedFlight.statusUpdates);
  const delayBaseTime = scrapedFlight.type === 'departures' ? scheduledDeparture : scheduledArrival;
  const estimatedTime = extractEstimatedTime(scrapedFlight.statusUpdates, delayBaseTime);

  // Cancelled flights should never have a delay — it's meaningless and
  // produces absurd values (e.g. 285 min for a flight that never operated).
  // Short-circuit: don't bother computing delayMinutes for cancelled flights.
  const effectiveDelayMinutes = canceled ? null : (
    sanitizedActualDeparture
      ? Math.round((sanitizedActualDeparture.getTime() - scheduledDeparture.getTime()) / 60_000)
      : sanitizedActualArrival
        ? Math.round((sanitizedActualArrival.getTime() - scheduledArrival.getTime()) / 60_000)
        : extractDelayMinutes(scrapedFlight.statusUpdates, delayBaseTime)
  );

  // Diverted arrivals never reach GCI — discard any actual_arrival that
  // might have been extracted from a status update about the diversion airport.
  const isDiverted = status?.toLowerCase().startsWith('divert');
  const effectiveActualArrival = (isDiverted && scrapedFlight.type === 'arrivals')
    ? null
    : sanitizedActualArrival;

  // Build the update set — only include fields that have data to avoid
  // overwriting richer data from other scrapers with nulls.
  const updateSet: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (sanitizedActualDeparture) updateSet.actualDeparture = sanitizedActualDeparture;
  if (effectiveActualArrival) updateSet.actualArrival   = effectiveActualArrival;
  if (status)                 updateSet.status          = status;
  if (canceled)               updateSet.canceled        = canceled;
  if (canceled)               updateSet.delayMinutes    = null;
  else if (effectiveDelayMinutes !== null) updateSet.delayMinutes = effectiveDelayMinutes;
  if (scheduledDeparture)     updateSet.scheduledDeparture = scheduledDeparture;
  if (scheduledArrival)       updateSet.scheduledArrival   = scheduledArrival;

  try {
    // First check if a flight already exists for this flight_number + flight_date + departure.
    // Including departure_airport disambiguates same-day opposing rotations
    // (e.g. GR644 GCI→BRS 12:45 departure vs GR644 BRS→GCI 17:00 arrival).
    const existing = await db
      .select({ id: flights.id, status: flights.status })
      .from(flights)
      .where(
        and(
          eq(flights.flightNumber, primaryCode),
          eq(flights.flightDate, scrapedFlight.flightDate),
          eq(flights.departureAirport, departureAirport),
        ),
      )
      .limit(1);
    let flightId: number | null;
    if (existing.length > 0) {
      const isDelayedCorrection = existing[0].status === 'Delayed' && status === 'Scheduled';
      if (status && !isDelayedCorrection && !canUpgradeStatus(existing[0].status, status)) {
        delete updateSet.status;
      }
      // If the DB says the flight is terminal (Landed/Diverted) but the
      // current scrape says it's still in progress (Delayed/Scheduled/etc),
      // the DB data is stale — force-clear it so the airport's live data wins.
      const isExistingTerminal = existing[0].status === 'Landed'
        || existing[0].status?.startsWith('Diverted');
      const isNewNonTerminal = status && status !== 'Landed'
        && status !== 'Cancelled' && !status.startsWith('Diverted');
      if (isExistingTerminal && isNewNonTerminal) {
        updateSet.status = status;
        updateSet.actualDeparture = null;
        updateSet.actualArrival = null;
        updateSet.delayMinutes = effectiveDelayMinutes;
      }
      if (isDelayedCorrection && effectiveDelayMinutes === 0) {
        updateSet.delayMinutes = 0;
      }

      // Update the existing record (may have been created by another scraper or a previous guernsey scrape)
      flightId = existing[0].id;
      if (Object.keys(updateSet).length > 1) { // > 1 because updatedAt is always present
        await db
          .update(flights)
          .set(updateSet)
          .where(eq(flights.id, flightId));
      }
    } else {
      // No existing record — insert a new one with guernsey unique_id
      const uniqueId = `${primaryCode}_${scrapedFlight.flightDate}_${departureAirport}_${arrivalAirport}`;
      const result = await db
        .insert(flights)
        .values({
          uniqueId,
          flightNumber: primaryCode,
          airlineCode: airlineCode(primaryCode),
          departureAirport,
          arrivalAirport,
          scheduledDeparture,
          scheduledArrival,
          actualDeparture:  sanitizedActualDeparture ?? undefined,
          actualArrival:    effectiveActualArrival ?? undefined,
          status:           status ?? undefined,
          canceled,
          delayMinutes:     effectiveDelayMinutes ?? undefined,
          flightDate:       scrapedFlight.flightDate,
        })
        .onConflictDoUpdate({ target: flights.uniqueId, set: updateSet as any })
        .returning({ id: flights.id });
      flightId = result[0]?.id ?? null;
    }

    // Write estimated time to flightTimes so the web app can display it.
    // Departures use EstimatedBlockOff (pushback time), arrivals use EstimatedBlockOn (landing time).
    // If the delay has resolved (no estimated time now), clear any stale estimate so the UI
    // doesn't continue showing a delay that no longer exists.
    if (flightId !== null) {
      const timeType = scrapedFlight.type === 'departures' ? 'EstimatedBlockOff' : 'EstimatedBlockOn';
      const isTerminal = status === 'Airborne' || status === 'Landed' || status === 'Cancelled' || status?.startsWith('Diverted');
      if (estimatedTime !== null) {
        await upsertFlightTime(flightId, timeType, estimatedTime);
      } else if (!isTerminal && !sanitizedActualDeparture && !sanitizedActualArrival) {
        await db.delete(flightTimes).where(
          and(eq(flightTimes.flightId, flightId), eq(flightTimes.timeType, timeType)),
        ).catch(() => {});
      }
    }

    return flightId;
  } catch (err) {
    console.error(`[Guernsey] Error upserting flight ${primaryCode} on ${scrapedFlight.flightDate}:`, err);
    return null;
  }
}

const SINGLETON_STATUS_PREFIXES = [
  'landed',
  'airborne',
  'diverted',
  'returned to stand',
];

function statusSingletonPrefix(msg: string): string | null {
  const lower = msg.toLowerCase();
  for (const prefix of SINGLETON_STATUS_PREFIXES) {
    if (lower.startsWith(prefix)) return prefix;
  }
  return null;
}

function normaliseStatusMessage(msg: string): string {
  return msg.replace(/\bNext Info\s+(\d{2})(\d{2})\b/gi, (_, h, m) => `Next Info ${h}:${m}`);
}
async function saveStatusUpdates(updates: StatusUpdate[], flightId: number | null): Promise<number> {
  let saved = 0;
  for (const u of updates) {
    const statusMessage = normaliseStatusMessage(u.statusMessage);
    try {
      if (flightId !== null) {
        const singletonPrefix = statusSingletonPrefix(statusMessage);
        if (singletonPrefix !== null) {
          const existing = await db
            .select({ msg: flightStatusHistory.statusMessage })
            .from(flightStatusHistory)
            .where(
              and(
                eq(flightStatusHistory.flightId, flightId),
                eq(flightStatusHistory.source, 'guernsey_airport'),
              ),
            );
          const alreadyHas = existing.some(r => r.msg.toLowerCase().startsWith(singletonPrefix));
          if (alreadyHas) continue;
        } else {
          const [{ n }] = await db
            .select({ n: count() })
            .from(flightStatusHistory)
            .where(
              and(
                eq(flightStatusHistory.flightId, flightId),
                eq(flightStatusHistory.source, 'guernsey_airport'),
                eq(flightStatusHistory.statusMessage, statusMessage),
              ),
            );
          if (n > 0) continue;
        }
      }
      await db
        .insert(flightStatusHistory)
        .values({
          flightCode:      u.flightCode,
          flightDate:      u.flightDate,
          statusTimestamp: u.statusTimestamp,
          statusMessage,
          source:          'guernsey_airport',
          flightId:        flightId ?? undefined,
        })
        .onConflictDoNothing();
      saved++;
    } catch (err) {
      console.error(`[Guernsey] Error saving update for ${u.flightCode}:`, err);
    }
  }
  return saved;
}

/**
 * One-shot linker: for any existing flight_status_history rows where flight_id
 * is NULL, attempt to match them to a flights row by flight_code + flight_date.
 */
export async function linkOrphanedStatusHistory(): Promise<number> {
  console.log('[Guernsey] Linking orphaned flight_status_history rows...');

  // Get all distinct (flight_code, flight_date) pairs that are unlinked
  const orphans = await db
    .selectDistinct({
      flightCode: flightStatusHistory.flightCode,
      flightDate: flightStatusHistory.flightDate,
    })
    .from(flightStatusHistory)
    .where(isNull(flightStatusHistory.flightId));

  console.log(`[Guernsey] Found ${orphans.length} unlinked (flight_code, flight_date) pairs`);

  let linked = 0;
  for (const orphan of orphans) {
    const match = await db
      .select({ id: flights.id })
      .from(flights)
      .where(
        and(
          eq(flights.flightNumber, orphan.flightCode),
          eq(flights.flightDate,   orphan.flightDate),
        ),
      )
      .limit(1);

    if (match.length === 0) continue;

    await db
      .update(flightStatusHistory)
      .set({ flightId: match[0].id })
      .where(
        and(
          eq(flightStatusHistory.flightCode, orphan.flightCode),
          eq(flightStatusHistory.flightDate, orphan.flightDate),
        ),
      );

    linked++;
  }

  console.log(`[Guernsey] Linked ${linked} / ${orphans.length} pairs`);
  return linked;
}

/**
 * One-shot deduplication: when multiple scrapers created rows for the same
 * flight_number + flight_date (e.g. numeric unique_id from fr24 and
 * flightNumber_date unique_id from guernsey), keep the numeric-id record
 * (typically richer data) and delete the guernsey duplicate.
 * Also repoints any flight_status_history rows.
 */
export async function deduplicateFlights(): Promise<number> {
  console.log('[Guernsey] Deduplicating flights (overlapping scraper records)...');

  // Find guernsey records (unique_id contains '_') that have a matching
  // numeric-id record for the same flight_number + flight_date
  const guernseyRecords = await db
    .select({
      id: flights.id,
      flightNumber: flights.flightNumber,
      flightDate: flights.flightDate,
    })
    .from(flights)
    .where(sql`position('_' in ${flights.uniqueId}) > 0`);

  if (guernseyRecords.length === 0) {
    console.log('[Guernsey] No guernsey-format records found');
    return 0;
  }

  // For each guernsey record, check if a numeric-id record exists
  const dupes: { guernseyId: number; keepId: number }[] = [];
  for (const g of guernseyRecords) {
    // Match by flight_number + flight_date. Then verify the guernsey and numeric
    // records share the same departure_airport — same-day opposing rotations
    // (e.g. GR644 GCI→BRS vs GR644 BRS→GCI) are separate flights, not dupes.
    const numericMatch = await db
      .select({ id: flights.id })
      .from(flights)
      .where(
        and(
          eq(flights.flightNumber, g.flightNumber),
          eq(flights.flightDate, g.flightDate),
          sql`position('_' in ${flights.uniqueId}) = 0`,
        ),
      )
      .limit(1);

    if (numericMatch.length > 0) {
      // Check if the guernsey record shares departure_airport with the numeric match.
      // If routes differ, they're separate rotations — don't dedupe.
      const guernseyDep = await db
        .select({ dep: flights.departureAirport })
        .from(flights)
        .where(eq(flights.id, g.id))
        .limit(1);
      const numericDep = await db
        .select({ dep: flights.departureAirport })
        .from(flights)
        .where(eq(flights.id, numericMatch[0].id))
        .limit(1);
      if (guernseyDep[0]?.dep === numericDep[0]?.dep) {
        dupes.push({ guernseyId: g.id, keepId: numericMatch[0].id });
      }
    }
  }

  if (dupes.length === 0) {
    console.log('[Guernsey] No duplicates found');
    return 0;
  }

  console.log(`[Guernsey] Found ${dupes.length} duplicate pairs`);

  let deleted = 0;
  for (const { guernseyId: guernsey_id, keepId: keep_id } of dupes) {
    // Repoint status history from guernsey record to the kept record
    await db
      .update(flightStatusHistory)
      .set({ flightId: keep_id })
      .where(eq(flightStatusHistory.flightId, guernsey_id));

    // Delete guernsey flight_times (can't just update — may conflict on unique constraint)
    await db.delete(flightTimes).where(eq(flightTimes.flightId, guernsey_id));

    // Delete the guernsey duplicate flight
    await db.delete(flights).where(eq(flights.id, guernsey_id));
    deleted++;
  }

  console.log(`[Guernsey] Deleted ${deleted} duplicate guernsey records`);
  return deleted;
}

async function scrapeDateRange(
  startDate: Date,
  endDate: Date,
  onProgress?: (current: Date, total: number, completed: number) => void,
): Promise<{ totalFlights: number; totalUpdates: number }> {
  const dates: Date[] = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    dates.push(new Date(d));
  }

  console.log(`[Guernsey] Scraping ${dates.length} days: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);

  let totalFlights = 0;
  let totalUpdates = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const dateStr = date.toISOString().split('T')[0];

    if (onProgress) onProgress(date, dates.length, i + 1);
    console.log(`[Guernsey] ${dateStr} (${i + 1}/${dates.length})`);

    // Polite delay between days — avoid rate-limiting
    if (i > 0) {
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    }

    try {
      const result = await scrapeDayFlights(date);
      totalFlights += result.flights;
      totalUpdates += result.updates;
      console.log(`  ${dateStr}: ${result.flights} flights, ${result.updates} updates`);
    } catch (err) {
      const msg = `Error on ${dateStr}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Guernsey] ${msg}`);

      await db.insert(scraperLogs).values({
        service: 'guernsey_historical',
        status: 'failure',
        errorMessage: msg,
        startedAt: new Date(),
        completedAt: new Date(),
      });
      // Continue to next day rather than aborting the whole backfill
    }
  }

  return { totalFlights, totalUpdates };
}

/**
 * Scrape all arrivals and departures for a single date.
 * Used by live mode to poll today (and optionally tomorrow).
 */
export async function scrapeDayFlights(date: Date): Promise<{ flights: number; updates: number }> {
  const dateStr = date.toISOString().slice(0, 10);
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const tomorrowDate = new Date();
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrowStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(tomorrowDate);
  const isLiveDate = dateStr === todayStr;
  let totalFlights = 0;
  let totalUpdates = 0;
  if (isLiveDate) {
    const apiData = await fetchApiData();
    for (const type of ['arrivals', 'departures'] as const) {
      const entries = type === 'arrivals' ? apiData.arrivals : apiData.departures;
      const scrapedFlights = mapApiEntriesToScrapedFlights(entries, type, dateStr);
      totalFlights += scrapedFlights.length;
      for (const flight of scrapedFlights) {
        const flightId = await upsertFlight(flight);
        totalUpdates += await saveStatusUpdates(flight.statusUpdates, flightId);
      }
    }
  }
  const html = await fetchDayHtml(date);
  for (const type of ['arrivals', 'departures'] as const) {
    const scrapedFlights = parseFlightHtml(html, date, type);
    totalFlights += scrapedFlights.length;
    for (const flight of scrapedFlights) {
      const flightId = await upsertFlight(flight);
      totalUpdates += await saveStatusUpdates(flight.statusUpdates, flightId);
    }
  }
  return { flights: totalFlights, updates: totalUpdates };
}
// Guernsey routes are at most ~2h flight time. Any delay exceeding this threshold
// is impossible in practice and indicates corrupted data from airport.gg.
const MAX_REALISTIC_DELAY_MINUTES = 360; // 6 hours

/**
 * One-shot fixer: corrects actual_departure, actual_arrival, and delay_minutes for
 * flights where airport.gg's late-posting behaviour produced bad values.
 *
 * Two passes:
 *
 * Pass 1 — next-day timestamp bug:
 *   actual_departure::date > flight_date  OR  actual_arrival::date > flight_date
 *   Re-derives correct time from status history anchored to scheduled time.
 *
 * Pass 2 — same-day late-timestamp bug:
 *   Historical flights with delay_minutes > MAX_REALISTIC_DELAY_MINUTES that were
 *   missed by pass 1 (status was posted same day but many hours after the flight).
 *   Nulls out actual times and delay_minutes that are clearly impossible.
 */
export async function fixActualTimes(): Promise<number> {
  let fixed = 0;

  // ── Pass 1: actual time is on a different date than flight_date ───────────
  console.log('[Guernsey] Pass 1: scanning for next-day timestamp corruptions...');

  const nextDayCorrupted = await db
    .select({
      id: flights.id,
      flightNumber: flights.flightNumber,
      flightDate: flights.flightDate,
      departureAirport: flights.departureAirport,
      scheduledDeparture: flights.scheduledDeparture,
      scheduledArrival: flights.scheduledArrival,
      actualDeparture: flights.actualDeparture,
      actualArrival: flights.actualArrival,
    })
    .from(flights)
    .where(
      or(
        and(
          isNotNull(flights.actualDeparture),
          sql`${flights.actualDeparture}::date > ${flights.flightDate}::date`,
        ),
        and(
          isNotNull(flights.actualArrival),
          sql`${flights.actualArrival}::date > ${flights.flightDate}::date`,
        ),
      ),
    );

  console.log(`[Guernsey] Pass 1: found ${nextDayCorrupted.length} flights`);

  for (const flight of nextDayCorrupted) {
    const history = await db
      .select({
        flightCode: flightStatusHistory.flightCode,
        flightDate: flightStatusHistory.flightDate,
        statusTimestamp: flightStatusHistory.statusTimestamp,
        statusMessage: flightStatusHistory.statusMessage,
      })
      .from(flightStatusHistory)
      .where(
        and(
          eq(flightStatusHistory.flightId, flight.id),
          eq(flightStatusHistory.source, 'guernsey_airport'),
        ),
      );

    if (history.length === 0) {
      console.log(`  [skip] ${flight.flightNumber} ${flight.flightDate} — no guernsey status history`);
      continue;
    }

    const updates: StatusUpdate[] = history.map(h => ({
      flightCode: h.flightCode,
      flightDate: typeof h.flightDate === 'string' ? h.flightDate : (h.flightDate as Date).toISOString().split('T')[0],
      statusTimestamp: h.statusTimestamp,
      statusMessage: h.statusMessage,
    }));

    const isDeparture = flight.departureAirport === 'GCI';
    const correctedDeparture = isDeparture
      ? extractActualTime(updates, 'Airborne', flight.scheduledDeparture)
      : null;
    const correctedArrival = !isDeparture
      ? extractActualTime(updates, 'Landed', flight.scheduledArrival)
      : null;

    const correctedDelay = correctedDeparture
      ? Math.round((correctedDeparture.getTime() - flight.scheduledDeparture.getTime()) / 60_000)
      : correctedArrival
        ? Math.round((correctedArrival.getTime() - flight.scheduledArrival.getTime()) / 60_000)
        : null;

    const updateSet: Record<string, unknown> = { updatedAt: new Date() };
    if (correctedDeparture) updateSet.actualDeparture = correctedDeparture;
    if (correctedArrival) updateSet.actualArrival = correctedArrival;
    if (correctedDelay !== null) updateSet.delayMinutes = correctedDelay;

    if (Object.keys(updateSet).length > 1) {
      await db.update(flights).set(updateSet as any).where(eq(flights.id, flight.id));
      const oldTime = (flight.actualDeparture ?? flight.actualArrival)?.toISOString();
      const newTime = (correctedDeparture ?? correctedArrival)?.toISOString();
      console.log(`  [fix-p1] ${flight.flightNumber} ${flight.flightDate}: ${oldTime} → ${newTime} (delay: ${correctedDelay ?? '—'} min)`);
      fixed++;
    }
  }

  // ── Pass 2: same-day late-timestamp — delay exceeds realistic maximum ─────
  // Airport.gg sometimes posts "Landed HH:MM" or "Delayed To HH:MM" hours after
  // the flight on the same calendar day, producing an impossible delay figure.
  // These were NOT caught by pass 1 because actual::date == flight_date.
  // Only process historical flights (flight_date < today) to avoid touching live data.
  console.log(`[Guernsey] Pass 2: scanning for same-day corruptions (delay > ${MAX_REALISTIC_DELAY_MINUTES} min)...`);

  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

  const largeDelay = await db
    .select({
      id: flights.id,
      flightNumber: flights.flightNumber,
      flightDate: flights.flightDate,
      departureAirport: flights.departureAirport,
      delayMinutes: flights.delayMinutes,
      actualDeparture: flights.actualDeparture,
      actualArrival: flights.actualArrival,
    })
    .from(flights)
    .where(
      and(
        isNotNull(flights.delayMinutes),
        sql`${flights.delayMinutes} > ${MAX_REALISTIC_DELAY_MINUTES}`,
        sql`${flights.flightDate}::date < ${todayStr}::date`,
      ),
    );

  console.log(`[Guernsey] Pass 2: found ${largeDelay.length} flights`);

  for (const flight of largeDelay) {
    const isDeparture = flight.departureAirport === 'GCI';
    const updateSet: Record<string, unknown> = {
      delayMinutes: null,
      updatedAt: new Date(),
    };
    // Only null the actual time that drove the bad delay — leave the other side untouched
    if (isDeparture && flight.actualDeparture !== null) {
      updateSet.actualDeparture = null;
    } else if (!isDeparture && flight.actualArrival !== null) {
      updateSet.actualArrival = null;
    }

    await db.update(flights).set(updateSet as any).where(eq(flights.id, flight.id));
    console.log(`  [fix-p2] ${flight.flightNumber} ${flight.flightDate}: cleared ${flight.delayMinutes} min delay`);
    fixed++;
  }

  console.log(`[Guernsey] Total fixed: ${fixed}`);
  return fixed;
}

export async function runBackfill(
  startDateStr?: string,
  endDateStr?: string,
  onProgress?: (current: Date, total: number, completed: number) => void,
): Promise<void> {
  const startDate = new Date(startDateStr || '2019-01-01');
  const endDate   = new Date(endDateStr   || guernseyTodayStr());

  console.log(`[Guernsey] Starting historical backfill: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);

  const logEntry = await db
    .insert(scraperLogs)
    .values({ service: 'guernsey_historical', status: 'retry', startedAt: new Date() })
    .returning({ id: scraperLogs.id });
  const logId = logEntry[0].id;

  try {
    const t0 = Date.now();
    const { totalFlights, totalUpdates } = await scrapeDateRange(startDate, endDate, onProgress);

    // Link any status rows whose flight_id is still null (e.g. codeshare codes
    // that don't have their own flights row)
    await linkOrphanedStatusHistory();

    const duration = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[Guernsey] Backfill done in ${duration}s — flights: ${totalFlights}, updates: ${totalUpdates}`);

    await db
      .update(scraperLogs)
      .set({ status: 'success', recordsScraped: totalUpdates, completedAt: new Date() })
      .where(eq(scraperLogs.id, logId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Guernsey] Backfill failed:', message);

    await db
      .update(scraperLogs)
      .set({ status: 'failure', errorMessage: message, completedAt: new Date() })
      .where(eq(scraperLogs.id, logId));

    throw err;
  }
}
