import { connect } from 'puppeteer-real-browser';
import type { Browser, Page } from 'rebrowser-puppeteer-core';
import { execSync } from 'child_process';
import { db, flights as flightsTable, flightStatusHistory, flightTimes, scraperLogs, canUpgradeStatus, isTerminalStatus, routeFlightMinutes, ROUTE_FLIGHT_MINUTES, localToUtc, guernseyTodayStr } from '@airways/database';
import { eq, and, max, desc, count } from 'drizzle-orm';
import { sendAlert } from '@airways/telegram';

const guernseyDateStr = guernseyTodayStr;
export { guernseyDateStr };

// ---------------------------------------------------------------------------
// Proxy helpers
// ---------------------------------------------------------------------------

interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

function getProxyList(): ProxyConfig[] {
  if (process.env.PROXY_ENABLED !== 'true') return [];

  const username = process.env.PROXY_USERNAME;
  const password = process.env.PROXY_PASSWORD;
  const hostsStr = process.env.PROXY_HOSTS;

  if (!username || !password || !hostsStr) {
    console.warn('[FR24] Proxy enabled but credentials/hosts not configured');
    return [];
  }

  return hostsStr.split(',').map(h => h.trim()).filter(Boolean).map(host => {
    const [ip, portStr] = host.split(':');
    return { host: ip, port: parseInt(portStr || '8080'), username, password };
  });
}

function getRandomProxy(proxies: ProxyConfig[]): ProxyConfig | null {
  if (proxies.length === 0) return null;
  return proxies[Math.floor(Math.random() * proxies.length)];
}

// ---------------------------------------------------------------------------
// Anti-bot helpers
// ---------------------------------------------------------------------------

function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function forceKillBrowser(browser: Browser | null): Promise<void> {
  if (!browser) return;
  const proc = (browser as any).process?.() ?? null;
  const pid = proc?.pid ?? null;
  await Promise.race([
    browser.close(),
    new Promise<void>(resolve => setTimeout(resolve, 5000)),
  ]).catch(() => {});
  if (pid != null) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
  try {
    const { execSync } = require('child_process');
    const output = execSync('ps aux | grep "chrome.*remote-debugging" | grep -v grep', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const match = line.match(/^\\S+\\s+(\\d+)/);
      if (match) {
        try {
          process.kill(parseInt(match[1], 10), 'SIGKILL');
        } catch {
        }
      }
    }
  } catch {
  }
  try {
    execSync(`rm -rf /tmp/.org.chromium.* /tmp/puppeteer_* /tmp/lighthouse.* /tmp/.com.google.Chrome.* 2>/dev/null || true`, { stdio: 'ignore' });
  } catch {
  }
}

async function simulateHumanBehavior(page: Page): Promise<void> {
  const scrollCount = Math.floor(Math.random() * 3) + 1;
  for (let i = 0; i < scrollCount; i++) {
    await page.evaluate((amount: number) => (globalThis as any).window.scrollBy(0, amount), Math.floor(Math.random() * 300) + 100);
    await randomDelay(500, 1500);
  }
  for (let i = 0; i < Math.floor(Math.random() * 5) + 3; i++) {
    await page.mouse.move(
      Math.floor(Math.random() * 800) + 100,
      Math.floor(Math.random() * 600) + 100,
      { steps: Math.floor(Math.random() * 5) + 3 },
    );
    await randomDelay(200, 800);
  }
}

// ---------------------------------------------------------------------------
// Guernsey-scraper-style location helpers
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Parsed flight type
// ---------------------------------------------------------------------------

interface ParsedFR24Flight {
  flightNumber: string;
  origin: string;      // IATA
  destination: string;  // IATA
  scheduledTime: string; // "HH:MM" or similar from FR24
  actualEstTime: string | null; // actual/estimated time
  status: string;
  aircraftType: string | null;
  aircraftReg: string | null;
  type: 'arrival' | 'departure';
}

// ---------------------------------------------------------------------------
// FR24 table parsing (runs inside page.evaluate)
// ---------------------------------------------------------------------------

/**
 * Extract flight rows from the FR24 airport page table.
 * FR24 renders a table with rows containing flight data.
 */
async function extractFlightRows(page: Page, type: 'arrival' | 'departure', targetDate: string): Promise<ParsedFR24Flight[]> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const rawRows = await page.evaluate((flightType: string) => {
    const doc = (globalThis as any).document;
    const rows: any[] = [];

    // FR24 uses a table with date header rows and flight data rows.
    // Date headers have a single <th> cell spanning all columns with text like "Monday, Mar 3"
    // or they are <tr> rows with class/data attributes indicating a date separator.
    const allElements = doc.querySelectorAll('table tbody tr, table thead tr');
    let currentDate = ''; // Track which date section we're in

    allElements.forEach((row: any) => {
      try {
        // Check if this is a date header row
        const headerCell = row.querySelector('th, td[colspan]');
        if (headerCell) {
          const headerText = headerCell.innerText?.trim() || '';
          // FR24 date headers look like "Monday, Mar 3" or "Today" or "Yesterday"
          // Also check for rows with single cell spanning all columns
          const cells = row.querySelectorAll('td, th');
          if (cells.length <= 2 && headerText.length > 2) {
            currentDate = headerText;
            return;
          }
        }

        const cells = row.querySelectorAll('td');
        if (cells.length < 4) return;

        const cellTexts = Array.from(cells).map((td: any) => td.innerText?.trim() || '');

        let flightNum = '';
        let scheduledTime = '';
        let originDest = '';
        let statusText = '';
        let aircraftText = '';

        // FR24 table structure: Time | Flight | From/To | Airline | Aircraft | Status
        if (cellTexts.length >= 6) {
          scheduledTime = cellTexts[0];
          flightNum = cellTexts[1];
          originDest = cellTexts[2];
          // cellTexts[3] is airline name — skip it
          aircraftText = cellTexts[4];
          statusText = cellTexts[cellTexts.length - 1];
        } else if (cellTexts.length >= 5) {
          scheduledTime = cellTexts[0];
          flightNum = cellTexts[1];
          originDest = cellTexts[2];
          aircraftText = cellTexts[3];
          statusText = cellTexts[cellTexts.length - 1];
        } else if (cellTexts.length >= 4) {
          scheduledTime = cellTexts[0];
          flightNum = cellTexts[1];
          originDest = cellTexts[2];
          statusText = cellTexts[cellTexts.length - 1];
        }

        if (!flightNum || !scheduledTime) return;

        // Skip if scheduledTime doesn't look like a time (HH:MM)
        if (!/\d{1,2}:\d{2}/.test(scheduledTime)) return;

        const iataMatch = originDest.match(/\(([A-Z]{3})\)/);
        const iataCode = iataMatch ? iataMatch[1] : null;
        if (!iataCode) return; // Skip rows where we can't extract a proper IATA code

        const timeMatch = statusText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
        const actualEstTime = timeMatch ? timeMatch[1] : null;

        const acTypeMatch = aircraftText.match(/^([A-Z0-9\s]+?)(?:\s*\(|$)/);
        const acRegMatch = aircraftText.match(/\(([A-Z0-9-]+)\)/);

        rows.push({
          flightNumber: flightNum,
          origin: flightType === 'arrival' ? iataCode : 'GCI',
          destination: flightType === 'arrival' ? 'GCI' : iataCode,
          scheduledTime,
          actualEstTime,
          status: statusText,
          aircraftType: acTypeMatch ? acTypeMatch[1].trim() : (aircraftText || null),
          aircraftReg: acRegMatch ? acRegMatch[1] : null,
          type: flightType,
          dateContext: currentDate,
          _rawCells: cellTexts.slice(0, 6),
        });
      } catch {
        // skip unparseable rows
      }
    });

    return rows;
  }, type);

  // Filter to only today's flights based on dateContext
  // FR24 date headers: "Today", "Monday, Mar 3", etc.
  // Accept flights where dateContext is empty (first section = today), "Today", or matches target date
  const todayDate = new Date(targetDate);
  const todayDay = todayDate.getDate();
  const todayMonthShort = todayDate.toLocaleString('en-US', { month: 'short' });

  const filtered = rawRows.filter((row: any) => {
    const ctx = (row.dateContext || '').toLowerCase();
    // If no date context, assume it's the default (today) section
    if (!ctx) return true;
    if (ctx.includes('today')) return true;
    // Match "Monday, Mar 3" pattern against target date
    if (ctx.includes(todayMonthShort.toLowerCase()) && ctx.includes(String(todayDay))) return true;
    return false;
  });

  console.log(`[FR24] Filtered ${rawRows.length} raw rows to ${filtered.length} for ${targetDate}`);

  // Debug: log what we're seeing in the aircraft column to diagnose registration extraction
  for (const row of filtered.slice(0, 5)) {
    const r = row as any;
    console.log(
      `[FR24] DEBUG ${r.flightNumber}: aircraftType=${r.aircraftType ?? 'null'}, ` +
      `aircraftReg=${r.aircraftReg ?? 'null'}, raw cells=${JSON.stringify(r._rawCells ?? 'n/a')}`,
    );
  }

  return filtered as ParsedFR24Flight[];
}

interface FlightDetailTimes {
  std: string | null;
  sta: string | null;
}

async function fetchFlightDetailTimes(
  page: Page,
  flightNumber: string,
  targetDate: string,
): Promise<FlightDetailTimes> {
  const detailUrl = `https://www.flightradar24.com/data/flights/${flightNumber.toLowerCase()}`;
  console.log(`[FR24] Fetching details for ${flightNumber} from ${detailUrl}`);

  try {
    await page.goto(detailUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('table tbody tr.data-row', { timeout: 10000 }).catch(() => {});
    await randomDelay(2000, 4000);
    await simulateHumanBehavior(page);
    const times = await page.evaluate((targetDateStr: string) => {
      const doc = (globalThis as any).document;
      const targetMidnight = new Date(targetDateStr);
      targetMidnight.setUTCHours(0, 0, 0, 0);
      const dayStart = targetMidnight.getTime() / 1000;
      const dayEnd = dayStart + 86400;
      const rows = doc.querySelectorAll('table tbody tr.data-row');
      const rowTimestamps = Array.from(rows).map((r: any) => parseInt(r.getAttribute('data-timestamp') || '0', 10));
      for (const row of rows) {
        const rowTs = parseInt((row as any).getAttribute('data-timestamp') || '0', 10);
        if (rowTs < dayStart || rowTs >= dayEnd) continue;
        const allCells = Array.from(row.querySelectorAll('td')) as any[];
        const timeCells = allCells.filter((td: any) => td.hasAttribute('data-timestamp'));
        const timeCellDebug = timeCells.map((td: any) => ({ ts: td.getAttribute('data-timestamp'), text: td.innerText?.trim() }));
        const extractTime = (td: any) => {
          const text = (td.innerText?.trim().replace(/\s+/g, ' ') || '');
          return /^\d{1,2}:\d{2}(\s*(AM|PM))?$/i.test(text) ? text : null;
        };
        let std: string | null = timeCells.length > 1 ? extractTime(timeCells[1]) : null;
        let sta: string | null = timeCells.length > 3 ? extractTime(timeCells[3]) : null;
        if (std || sta) return { std, sta, _debug: null, _timeCells: timeCellDebug };
      }
      const matchedRow = Array.from(rows).find((r: any) => {
        const ts = parseInt(r.getAttribute('data-timestamp') || '0', 10);
        return ts >= dayStart && ts < dayEnd;
      }) as any;
      const matchedCells = matchedRow ? Array.from(matchedRow.querySelectorAll('td')).map((td: any) => ({ cls: td.className, ts: td.getAttribute('data-timestamp'), text: td.innerText?.trim().slice(0, 20) })) : [];
      return { std: null, sta: null, _debug: { totalRows: rows.length, dayStart, dayEnd, rowTimestamps, matchedCells } };
    }, targetDate);

    if (times._debug) {
      console.log(`[FR24] Detail parse debug for ${flightNumber}:`, JSON.stringify(times._debug));
    }
    console.log(`[FR24] Found times for ${flightNumber}: STD=${times.std}, STA=${times.sta}`);
    return times;
  } catch (error) {
    console.error(`[FR24] Error fetching details for ${flightNumber}:`, error);
    return { std: null, sta: null };
  }
}

async function clickLoadEarlierFlights(page: Page): Promise<void> {
  // FR24 loads ~80 rows per click; GCI typically has <30 flights/day.
  // 2 clicks is enough to capture all of today's flights.
  const maxClicks = 2;
  for (let i = 0; i < maxClicks; i++) {
    // Count rows before clicking to detect when no new rows are added
    const rowCountBefore = await page.evaluate(() => {
      return (globalThis as any).document.querySelectorAll('table tbody tr').length;
    });

    try {
      // Try text-based search for the "load earlier" button
      const buttons = await page.$$('button, a.btn, a');
      let found = false;
      for (const btn of buttons) {
        const text = await btn.evaluate(el => (el as any).innerText?.toLowerCase() || '');
        if (text.includes('earlier') || text.includes('load more') || text.includes('show more')) {
          await btn.evaluate(el => (el as any).scrollIntoView({ behavior: 'smooth', block: 'center' }));
          await randomDelay(500, 1000);
          await btn.click().catch(() => btn.evaluate(el => (el as any).click()));
          found = true;
          console.log(`[FR24] Clicked "load earlier flights" button (attempt ${i + 1})`);
          await randomDelay(2000, 4000);
          break;
        }
      }
      if (!found) {
        console.log('[FR24] No "load earlier flights" button found — all flights loaded');
        break;
      }

      // Check if clicking actually loaded more rows
      const rowCountAfter = await page.evaluate(() => {
        return (globalThis as any).document.querySelectorAll('table tbody tr').length;
      });
      if (rowCountAfter <= rowCountBefore) {
        console.log(`[FR24] No new rows loaded (${rowCountBefore} → ${rowCountAfter}) — stopping`);
        break;
      }
      console.log(`[FR24] Rows: ${rowCountBefore} → ${rowCountAfter}`);
    } catch (err) {
      console.log('[FR24] Error clicking load earlier button, may be fully loaded:', err);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Status normalization
// ---------------------------------------------------------------------------

/**
 * Normalize FR24 status text to our standard vocabulary.
 *
 * FR24 "Estimated HH:MM" is their default status for upcoming flights — it does NOT
 * mean delayed. We return 'Scheduled' for "estimated" and let the caller compare the
 * estimated time vs scheduled time to determine if the flight is actually delayed.
 */
function normalizeStatus(rawStatus: string): string {
  const s = rawStatus.trim().toLowerCase();
  if (s.includes('landed')) return 'Landed';
  if (s.includes('cancelled') || s.includes('canceled')) return 'Cancelled';
  if (s.includes('diverted')) return 'Diverted';
  if (s.includes('airborne') || s.includes('en route') || s.includes('in flight')) return 'Airborne';
  if (s.includes('delayed')) return 'Delayed';
  if (s.includes('scheduled') || s.includes('on time')) return 'Scheduled';
  if (s.includes('boarding')) return 'Boarding';
  if (s.includes('departed') || s.includes('took off')) return 'Airborne';
  if (s.includes('arrived')) return 'Landed';
  // FR24 "Estimated HH:MM" / "Expected HH:MM" = on time unless proven otherwise
  if (s.includes('estimated') || s.includes('expected')) return 'Scheduled';
  return rawStatus.trim() || 'Scheduled';
}

// ---------------------------------------------------------------------------
// Flight number cleanup
// ---------------------------------------------------------------------------

function cleanFlightNumber(raw: string): string {
  // FR24 shows "GR 670" — normalize to "GR670"
  return raw.replace(/\s+/g, '').toUpperCase();
}

// Skybus (SI) and Blue Islands AT6 series (AT) operate under Aurigny (GR)
function extractAirlineCode(flightNumber: string): string {
  const match = flightNumber.match(/^([A-Z]{2})/);
  const code = match ? match[1] : 'XX';
  if (code === 'SI' || code === 'AT') return 'GR';
  return code;
}

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

function parseTimeToDate(timeStr: string, flightDate: string): Date | null {
  // FR24 uses 12h AM/PM format: "8:01 AM", "4:57 PM", or sometimes 24h "16:57"
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const ampm = match[3]?.toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return localToUtc(flightDate, hour, minute);
}



// ---------------------------------------------------------------------------
// DB upsert
// ---------------------------------------------------------------------------

async function guernseyEstimatedTimeHasPriority(
  flightId: number,
  timeType: string,
  fr24EstimatedTime: Date,
): Promise<boolean> {
  const [latestGuernsey] = await db
    .select({ ts: max(flightStatusHistory.statusTimestamp) })
    .from(flightStatusHistory)
    .where(
      and(
        eq(flightStatusHistory.flightId, flightId),
        eq(flightStatusHistory.source, 'guernsey_airport'),
      ),
    );
  const [existing] = await db
    .select({ timeValue: flightTimes.timeValue })
    .from(flightTimes)
    .where(
      and(
        eq(flightTimes.flightId, flightId),
        eq(flightTimes.timeType, timeType),
      ),
    );
  if (!latestGuernsey?.ts || !existing?.timeValue) return false;
  const guernseyTs = new Date(latestGuernsey.ts);
  const existingEstimate = new Date(existing.timeValue);
  const now = new Date(); // UTC — container runs TZ=UTC, consistent with DB storage
  const guernseyEstimateStillFuture = existingEstimate > now;
  const guernseyIsNewer = guernseyTs > fr24EstimatedTime;
  return guernseyEstimateStillFuture && guernseyIsNewer;
}

async function upsertFR24Flight(
  flight: ParsedFR24Flight,
  flightDate: string,
  detailTimes?: FlightDetailTimes,
): Promise<number | null> {
  const flightNumber = cleanFlightNumber(flight.flightNumber);
  if (!flightNumber || flightNumber.length < 3) return null;

  const airlineCode = extractAirlineCode(flightNumber);

  // Keep Aurigny (GR) and British Airways (BA) flights only
  if (airlineCode !== 'GR' && airlineCode !== 'BA') {
    return null;
  }
  let status = normalizeStatus(flight.status);
  const canceled = status === 'Cancelled';

  // Truncate aircraft fields to fit DB varchar(20) constraints.
  // Validate aircraftType looks like a real type code (e.g. "ATR 72", "DHC8", "A320")
  // and not a misread airline name (e.g. "Isles of Scilly Skyb").
  const rawAcType = flight.aircraftType?.slice(0, 20) ?? null;
  const aircraftType = rawAcType && /^[A-Z0-9][A-Z0-9\s-]{1,19}$/.test(rawAcType) ? rawAcType : null;
  const aircraftReg = flight.aircraftReg ? flight.aircraftReg.slice(0, 20) : null;

  // Parse scheduled time
  const scheduledTimeDate = parseTimeToDate(flight.scheduledTime, flightDate);
  if (!scheduledTimeDate) {
    console.warn(`[FR24] Skipping ${flightNumber}: unparseable time "${flight.scheduledTime}"`);
    return null;
  }

  // For FR24, origin/destination IATA codes
  let departureAirport = flight.origin || 'GCI';
  let arrivalAirport = flight.destination || 'GCI';

  // Ensure GCI is always one endpoint
  if (flight.type === 'arrival') {
    arrivalAirport = 'GCI';
    if (!departureAirport || departureAirport === 'GCI') departureAirport = '???';
  } else {
    departureAirport = 'GCI';
    if (!arrivalAirport || arrivalAirport === 'GCI') arrivalAirport = '???';
  }

  // Estimate the other time using route duration
  const otherIata = flight.type === 'arrival' ? departureAirport : arrivalAirport;
  const flightMins = routeFlightMinutes(otherIata);

  let scheduledDeparture: Date;
  let scheduledArrival: Date;

  if (detailTimes?.std && detailTimes?.sta) {
    const stdDate = parseTimeToDate(detailTimes.std, flightDate);
    const staDate = parseTimeToDate(detailTimes.sta, flightDate);

    if (stdDate && staDate) {
      scheduledDeparture = stdDate;
      scheduledArrival = staDate;
      console.log(`[FR24] Using detail page times for ${flightNumber}: STD=${detailTimes.std}, STA=${detailTimes.sta}`);
    } else {
      console.warn(`[FR24] Failed to parse detail times for ${flightNumber}, falling back to route calculation`);
      if (flight.type === 'departure') {
        scheduledDeparture = scheduledTimeDate;
        scheduledArrival = new Date(scheduledTimeDate.getTime() + flightMins * 60_000);
      } else {
        scheduledArrival = scheduledTimeDate;
        scheduledDeparture = new Date(scheduledTimeDate.getTime() - flightMins * 60_000);
      }
    }
  } else {
    if (flight.type === 'departure') {
      scheduledDeparture = scheduledTimeDate;
      scheduledArrival = new Date(scheduledTimeDate.getTime() + flightMins * 60_000);
    } else {
      scheduledArrival = scheduledTimeDate;
      scheduledDeparture = new Date(scheduledTimeDate.getTime() - flightMins * 60_000);
    }
  }

  // Parse actual/estimated time from FR24 status column
  let actualDeparture: Date | null = null;
  let actualArrival: Date | null = null;
  let estimatedTime: Date | null = null;

  if (flight.actualEstTime) {
    const parsedTime = parseTimeToDate(flight.actualEstTime, flightDate);
    const now = new Date(); // UTC — container runs TZ=UTC, consistent with DB storage
    if (parsedTime) {
      // Only treat times as "actual" if they are in the past — all times are UTC
      if (status === 'Landed' && flight.type === 'arrival' && parsedTime <= now) {
        actualArrival = parsedTime;
      } else if ((status === 'Airborne' || status === 'Landed') && flight.type === 'departure' && parsedTime <= now) {
        actualDeparture = parsedTime;
      } else {
        // FR24 "Estimated HH:MM" — record the estimated time for display
        // but do NOT derive status or delay from it. Guernsey scraper owns
        // status/delay decisions. FR24 estimates are informational only and
        // frequently differ from scheduled times even for on-time flights.
        estimatedTime = parsedTime;
      }
    }
  }

  // ponytail: guernsey-scraper owns delay; FR24 estimated times are display-only.
  // Let flightTimes carry the estimated time, don't set delayMinutes on flights table.
  const delayMinutes: number | null = null;

  try {
    // First check if a flight already exists for this flight_number + flight_date
    // This handles dedup with guernsey-scraper records
    const existing = await db
      .select({
        id: flightsTable.id,
        uniqueId: flightsTable.uniqueId,
        status: flightsTable.status,
        scheduledDeparture: flightsTable.scheduledDeparture,
        scheduledArrival: flightsTable.scheduledArrival,
        actualDeparture: flightsTable.actualDeparture,
        actualArrival: flightsTable.actualArrival,
        delayMinutes: flightsTable.delayMinutes,

      })
      .from(flightsTable)
      .where(
        and(
          eq(flightsTable.flightNumber, flightNumber),
          eq(flightsTable.flightDate, flightDate),
        ),
      )
      .limit(1);

    let flightId: number | null;

    const updateSet: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    // Aircraft metadata — always safe to write
    if (aircraftType) updateSet.aircraftType = aircraftType;
    if (aircraftReg) {
      updateSet.aircraftRegistration = aircraftReg;
      console.log(`[FR24] Writing registration ${aircraftReg} for ${flightNumber}`);
    }
    if (existing.length > 0) {
      const ex = existing[0];
      const isDelayedCorrection = ex.status === 'Delayed' && status === 'Scheduled';
      if (status && (isDelayedCorrection || canUpgradeStatus(ex.status, status))) {
        updateSet.status = status;
      }
      if (canceled) {
        updateSet.canceled = canceled;
      }
      // Status, delay, actual departure/arrival are owned by guernsey-scraper — do not overwrite
      if (detailTimes?.std && detailTimes?.sta) {
        const currentDepMs = ex.scheduledDeparture?.getTime() ?? 0;
        const currentArrMs = ex.scheduledArrival?.getTime() ?? 0;
        const newDepMs = scheduledDeparture.getTime();
        const newArrMs = scheduledArrival.getTime();
        const depDriftMs = Math.abs(currentDepMs - newDepMs);
        const maxAllowedDriftMs = 30 * 60_000;
        if (depDriftMs > 60000 && depDriftMs <= maxAllowedDriftMs) {
          updateSet.scheduledDeparture = scheduledDeparture;
          console.log(`[FR24] Updating scheduledDeparture for ${flightNumber}: ${ex.scheduledDeparture} -> ${scheduledDeparture}`);
        } else if (depDriftMs > maxAllowedDriftMs) {
          console.warn(`[FR24] Rejecting scheduledDeparture update for ${flightNumber}: drift ${Math.round(depDriftMs / 60000)}min exceeds 30min limit (${ex.scheduledDeparture} -> ${scheduledDeparture})`);
        }
        if (Math.abs(currentArrMs - newArrMs) > 60000) {
          updateSet.scheduledArrival = scheduledArrival;
          console.log(`[FR24] Updating scheduledArrival for ${flightNumber}: ${ex.scheduledArrival} -> ${scheduledArrival}`);
        }
      }
      flightId = existing[0].id;
      if (Object.keys(updateSet).length > 1) {
        await db
          .update(flightsTable)
          .set(updateSet)
          .where(eq(flightsTable.id, flightId));
      }
    } else {
      return null;
    }
    if (flightId === null) return null;

    // Write estimated time to flightTimes (or remove stale estimate if on-time)
    const estTimeType = flight.type === 'departure' ? 'EstimatedBlockOff' : 'EstimatedBlockOn';
    if (estimatedTime) {
      const guernseyHasPriority = await guernseyEstimatedTimeHasPriority(flightId, estTimeType, estimatedTime);
      if (!guernseyHasPriority) {
        await db
          .insert(flightTimes)
          .values({ flightId, timeType: estTimeType, timeValue: estimatedTime })
          .onConflictDoUpdate({
            target: [flightTimes.flightId, flightTimes.timeType],
            set: { timeValue: estimatedTime },
          });
      } else {
        console.log(`[FR24] Skipping EstimatedBlockOff/On write for flight ${flightId} — Guernsey airport has a newer estimate still in the future`);
      }
    } else if (actualDeparture || actualArrival || isTerminalStatus(status ?? '')) {
      await db
        .delete(flightTimes)
        .where(
          and(
            eq(flightTimes.flightId, flightId),
            eq(flightTimes.timeType, estTimeType),
          ),
        ).catch(() => {});
    } else {
      // FR24 shows on-time (no estimated delay). Clear any stale estimate from a previous
      // scrape unless guernsey is actively showing a delay. Check by looking for delay keywords
      // in guernsey's latest status history entry.
      const [latestGuernsey] = await db
        .select({ msg: flightStatusHistory.statusMessage })
        .from(flightStatusHistory)
        .where(and(eq(flightStatusHistory.flightId, flightId), eq(flightStatusHistory.source, 'guernsey_airport')))
        .orderBy(desc(flightStatusHistory.statusTimestamp))
        .limit(1);
      const guernseyActiveDelay = latestGuernsey?.msg
        ? (() => {
            const m = latestGuernsey.msg.toLowerCase();
            return m.includes('delayed') || m.startsWith('approx') || m.includes('new etd') ||
              m.includes('expected at') || m.includes('delayed until') || m.includes('boarding expected') ||
              m.includes('next info');
          })()
        : false;
      if (!guernseyActiveDelay) {
        await db
          .delete(flightTimes)
          .where(and(eq(flightTimes.flightId, flightId), eq(flightTimes.timeType, estTimeType)))
          .catch(() => {});
      }
    }

    // Write actual times to flightTimes — only if the DB doesn't already have a value
    // (guernsey scraper provides more accurate actual times)
    const ex = existing.length > 0 ? existing[0] : null;
    if (actualDeparture && (ex == null || ex.actualDeparture == null)) {
      await db
        .insert(flightTimes)
        .values({ flightId, timeType: 'ActualBlockOff', timeValue: actualDeparture })
        .onConflictDoUpdate({
          target: [flightTimes.flightId, flightTimes.timeType],
          set: { timeValue: actualDeparture },
        });
    }
    if (actualArrival && (ex == null || ex.actualArrival == null)) {
      await db
        .insert(flightTimes)
        .values({ flightId, timeType: 'ActualBlockOn', timeValue: actualArrival })
        .onConflictDoUpdate({
          target: [flightTimes.flightId, flightTimes.timeType],
          set: { timeValue: actualArrival },
        });
    }

    // Insert status history
    try {
      const rawMessage = flight.status || status;
      let skipHistory = false;
      if (rawMessage.toLowerCase().startsWith('estimated dep')) {
        const timeMatch = rawMessage.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (timeMatch) {
          let hh = parseInt(timeMatch[1]);
          const mm = parseInt(timeMatch[2]);
          const ampm = timeMatch[3].toUpperCase();
          if (ampm === 'PM' && hh !== 12) hh += 12;
          if (ampm === 'AM' && hh === 12) hh = 0;
          const ex = existing[0];
          const scheduledMs = ex?.scheduledDeparture ? new Date(ex.scheduledDeparture).getTime() : null;
          if (scheduledMs !== null) {
            // Convert London local time to UTC for proper comparison
            const estDate = parseTimeToDate(`${hh}:${String(mm).padStart(2, '0')}`, flightDate);
            if (estDate && estDate.getTime() <= scheduledMs) skipHistory = true;
          }
        }
      }
      if (!skipHistory) {
        await db
          .insert(flightStatusHistory)
          .values({
            flightCode: flightNumber,
            flightDate,
            statusTimestamp: new Date(),
            statusMessage: rawMessage,
            source: 'fr24',
            flightId,
          })
          .onConflictDoNothing();
      }
    } catch {
    }

    return flightId;
  } catch (err) {
    console.error(`[FR24] Error upserting ${flightNumber}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core browser session
// ---------------------------------------------------------------------------

async function runBrowserSession(
  logId: number,
  maxRetries: number,
): Promise<{ success: boolean; count: number; error?: string }> {
  const flightDate = guernseyDateStr();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let browser: Browser | null = null;
    try {
      console.log(`[FR24] Attempt ${attempt}/${maxRetries} — date: ${flightDate}`);
      await randomDelay(3000, 8000);

      const proxies = getProxyList();
      const selectedProxy = getRandomProxy(proxies);

      if (selectedProxy) {
        console.log(`[FR24] Using proxy: ${selectedProxy.host}:${selectedProxy.port}`);
      } else {
        console.log('[FR24] No proxy configured - connecting directly');
      }

      console.log('[FR24] Launching browser...');

      const isDocker = process.env.CHROME_PATH !== undefined;
      const chromePath = process.env.CHROME_PATH;
      const connectOptions: Record<string, unknown> = {
        headless: false,
        turnstile: true,
        disableXvfb: true,
        args: [
          '--disable-dev-shm-usage',
          '--window-size=1920,1080',
          '--lang=en-GB',
          '--accept-lang=en-GB,en;q=0.9',
          ...(isDocker ? [
            '--no-sandbox',
            '--disable-setuid-sandbox',
          ] : []),
        ],
      };

      if (chromePath) {
        connectOptions.customConfig = { chromePath };
      }

      if (selectedProxy) {
        connectOptions.proxy = {
          host: selectedProxy.host,
          port: selectedProxy.port,
          username: selectedProxy.username,
          password: selectedProxy.password,
        };
      }

      const { browser: b, page } = await connect(connectOptions);
      console.log('[FR24] Browser launched successfully');
      browser = b;

      let totalUpserted = 0;

      // ---- Scrape arrivals ----
      console.log('[FR24] Loading arrivals page...');
      await page.goto('https://www.flightradar24.com/data/airports/gci/arrivals', {
        waitUntil: 'networkidle2',
        timeout: 120000,
      });

      // Wait for Cloudflare challenge if present
      let title = await page.title().catch(() => '');
      let waitAttempts = 0;
      while (title.includes('Just a moment') && waitAttempts < 10) {
        console.log('[FR24] Waiting for Cloudflare challenge...');
        await randomDelay(5000, 10000);
        title = await page.title().catch(() => '');
        waitAttempts++;
      }
      if (title.includes('Just a moment')) {
        throw new Error('Cloudflare challenge not bypassed after 10 attempts — browser fingerprint may need updating');
      }

      // Wait for table to render
      console.log('[FR24] Waiting for flight table to render...');
      await page.waitForSelector('table', { timeout: 30000 }).catch(() => {
        console.log('[FR24] No table found via waitForSelector, will try to extract anyway');
      });
      await randomDelay(3000, 5000);

      // Click "load earlier flights" button to get all flights
      await clickLoadEarlierFlights(page);
      await simulateHumanBehavior(page);

      const arrivalFlights = await extractFlightRows(page, 'arrival', flightDate);
      console.log(`[FR24] Parsed ${arrivalFlights.length} arrival rows`);
      if (arrivalFlights.length === 0) {
        const debugTitle = await page.title().catch(() => 'unknown');
        const debugUrl = page.url();
        const snippet = await page.evaluate(() => (globalThis as any).document.body?.innerHTML?.slice(0, 2000) || '').catch(() => 'unable to read');
        console.log(`[FR24] DEBUG arrivals empty — title="${debugTitle}" url="${debugUrl}"`);
        console.log(`[FR24] DEBUG arrivals HTML snippet: ${snippet}`);
      }

      for (const flight of arrivalFlights) {
        const id = await upsertFR24Flight(flight, flightDate, undefined);
        if (id !== null) totalUpserted++;
      }

      // ---- Scrape departures ----
      await randomDelay(3000, 6000);
      console.log('[FR24] Loading departures page...');
      await page.goto('https://www.flightradar24.com/data/airports/gci/departures', {
        waitUntil: 'networkidle2',
        timeout: 120000,
      });

      // Wait for Cloudflare again if needed
      title = await page.title().catch(() => '');
      waitAttempts = 0;
      while (title.includes('Just a moment') && waitAttempts < 10) {
        console.log('[FR24] Waiting for Cloudflare challenge...');
        await randomDelay(5000, 10000);
        title = await page.title().catch(() => '');
        waitAttempts++;
      }
      if (title.includes('Just a moment')) {
        throw new Error('Cloudflare challenge not bypassed on departures page after 10 attempts');
      }

      await page.waitForSelector('table', { timeout: 30000 }).catch(() => {
        console.log('[FR24] No table found via waitForSelector, will try to extract anyway');
      });
      await randomDelay(3000, 5000);

      // Click "load earlier flights" on departures too
      await clickLoadEarlierFlights(page);
      await simulateHumanBehavior(page);

      const departureFlights = await extractFlightRows(page, 'departure', flightDate);
      console.log(`[FR24] Parsed ${departureFlights.length} departure rows`);
      if (departureFlights.length === 0) {
        const debugTitle = await page.title().catch(() => 'unknown');
        const debugUrl = page.url();
        const snippet = await page.evaluate(() => (globalThis as any).document.body?.innerHTML?.slice(0, 2000) || '').catch(() => 'unable to read');
        console.log(`[FR24] DEBUG departures empty — title="${debugTitle}" url="${debugUrl}"`);
        console.log(`[FR24] DEBUG departures HTML snippet: ${snippet}`);
      }
      const detailFetchedThisRun = new Set<string>();
      for (const flight of departureFlights) {
        const flightNumber = flight.flightNumber.replace(/\s+/g, '').toUpperCase();
        const isKnownRoute = flight.destination in ROUTE_FLIGHT_MINUTES;
        const isGR = flightNumber.startsWith('GR');
        let needsDetailFetch = false;
        if (isGR && isKnownRoute && !detailFetchedThisRun.has(flightNumber)) {
          const existing = await db.select({ scheduledDeparture: flightsTable.scheduledDeparture, scheduledArrival: flightsTable.scheduledArrival })
            .from(flightsTable)
            .where(and(eq(flightsTable.flightNumber, flightNumber), eq(flightsTable.flightDate, flightDate)))
            .limit(1);
          if (existing.length > 0) {
            const ex = existing[0];
            const calculatedArrival = ex.scheduledDeparture.getTime() + routeFlightMinutes(flight.destination) * 60_000;
            const storedArrival = ex.scheduledArrival.getTime();
            needsDetailFetch = Math.abs(storedArrival - calculatedArrival) < 60_000;
          }
        }
        if (needsDetailFetch) detailFetchedThisRun.add(flightNumber);
        const detailTimes = needsDetailFetch
          ? await fetchFlightDetailTimes(page, flight.flightNumber, flightDate)
          : undefined;
        if (needsDetailFetch) {
          await randomDelay(3000, 5000);
        }
        const id = await upsertFR24Flight(flight, flightDate, detailTimes);
        if (id !== null) totalUpserted++;
      }

      // ---- Complete ----
      await db.update(scraperLogs)
        .set({ status: 'success', recordsScraped: totalUpserted, completedAt: new Date(), retryCount: attempt - 1 })
        .where(eq(scraperLogs.id, logId));

      console.log('[FR24] Closing browser...');
      await Promise.race([
        page.close(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]).catch(() => {});
      await forceKillBrowser(browser);
      browser = null;
      console.log('[FR24] Browser closed');
      if (global.gc) global.gc();
      return { success: true, count: totalUpserted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[FR24] Attempt ${attempt} failed: ${message}`);
      await forceKillBrowser(browser);
      browser = null;

      if (attempt < maxRetries) {
        const backoff = Math.pow(2, attempt) * 5000 + Math.random() * 5000;
        console.log(`[FR24] Retrying in ${Math.round(backoff / 1000)}s...`);
        await randomDelay(backoff, backoff + 5000);
      } else {
        await db.update(scraperLogs)
          .set({ status: 'failure', errorMessage: message, completedAt: new Date(), retryCount: maxRetries })
          .where(eq(scraperLogs.id, logId));
        sendAlert('fr24-scraper', 'critical', `All ${maxRetries} retries exhausted`, message).catch(() => {});
        return { success: false, count: 0, error: message };
      }
    }
  }

  return { success: false, count: 0, error: 'Exhausted retries' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function scrapeOnce(): Promise<{ success: boolean; count: number; error?: string }> {
  const logEntry = await db
    .insert(scraperLogs)
    .values({ service: 'fr24_live', status: 'retry', startedAt: new Date(), retryCount: 0 })
    .returning({ id: scraperLogs.id });
  const logId = logEntry[0].id;

  const maxRetries = parseInt(process.env.SCRAPER_MAX_RETRIES || '3');
  return runBrowserSession(logId, maxRetries);
}
