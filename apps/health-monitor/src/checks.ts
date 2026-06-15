import { getDb } from '@airways/database';
import {
  scraperLogs,
  flights,
  notificationWatermark,
  flightStatusHistory,
  pushSubscriptions,
  weatherData,
} from '@airways/database/schema';
import { sql, eq, and, gte, desc } from 'drizzle-orm';

export interface CheckResult {
  name: string;
  passed: boolean;
  value: string;
  threshold: string;
  samples?: Record<string, unknown>[];
}

// ── Service list ───────────────────────────────────────────────────
// Logical service names (our keys) → actual DB scraper_logs.service values.
// Only services that write to scraper_logs are included here.
// Other services (position, weather, notification) are monitored via their
// respective data-table recency checks (position_gap, stale_weather, watermark_lag).
const SCRAPER_SERVICES: { key: string; dbValue: string; staleMins: number }[] = [
  { key: 'guernsey', dbValue: 'guernsey_live', staleMins: parseInt(process.env.STALE_GUERNSEY_MINS ?? '30', 10) },
  { key: 'fr24', dbValue: 'fr24_live', staleMins: parseInt(process.env.STALE_FR24_MINS ?? '30', 10) },
];

function staleThresholdMins(key: string): number {
  const s = SCRAPER_SERVICES.find(s => s.key === key);
  return s?.staleMins ?? 30;
}

function dbServiceName(key: string): string {
  const s = SCRAPER_SERVICES.find(s => s.key === key);
  return s?.dbValue ?? key;
}

// ── Error wrapper — per-check isolation ────────────────────────────

function failedCheck(name: string, threshold: string, reason: string): CheckResult {
  return {
    name,
    passed: false,
    value: 'error',
    threshold,
    samples: [{ error: reason }],
  };
}

async function safeCheck(
  name: string,
  threshold: string,
  fn: () => Promise<CheckResult[]>,
): Promise<CheckResult[]> {
  try {
    return await fn();
  } catch (err) {
    return [failedCheck(name, threshold, (err as Error).message)];
  }
}

// ── Scraper Health Checks (consolidated) ───────────────────────────

/** Last scraper_log per service — staleness check (single query) */
async function checkScraperStaleness(): Promise<CheckResult[]> {
  const db = getDb();
  const now = new Date();
  const results: CheckResult[] = [];

  const rows = await db.execute(sql`
    SELECT DISTINCT ON (service) service, started_at
    FROM scraper_logs
    ORDER BY service, started_at DESC
  `);

  const latestMap = new Map<string, Date>();
  for (const r of rows.rows) {
    const row = r as { service: string; started_at: string };
    latestMap.set(row.service, new Date(row.started_at));
  }

  for (const svc of SCRAPER_SERVICES) {
    const thresholdMins = svc.staleMins;
    const thresholdMs = thresholdMins * 60 * 1000;
    const latest = latestMap.get(svc.dbValue);

    if (!latest) {
      results.push({
        name: `${svc.key}_last_run`,
        passed: false,
        value: 'never',
        threshold: `${thresholdMins}m`,
        samples: [{ service: svc.key, reason: 'no scraper logs found' }],
      });
      continue;
    }

    const ageMs = now.getTime() - latest.getTime();
    const ageMins = Math.round(ageMs / 60000);
    results.push({
      name: `${svc.key}_last_run`,
      passed: ageMs < thresholdMs,
      value: `${ageMins}m ago`,
      threshold: `${thresholdMins}m`,
      ...(ageMs >= thresholdMs && {
        samples: [{ service: svc.key, lastStartedAt: latest.toISOString(), ageMins }],
      }),
    });
  }

  return results;
}

/** Failure rate per service in the last 6 hours (2 consolidated queries) */
async function checkScraperFailureRate(): Promise<CheckResult[]> {
  const db = getDb();
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const [totalsRes, failuresRes] = await Promise.all([
    db.execute(sql`
      SELECT service, count(*)::int AS count
      FROM scraper_logs
      WHERE started_at >= ${sixHoursAgo.toISOString()}
      GROUP BY service
    `),
    db.execute(sql`
      SELECT service, count(*)::int AS count
      FROM scraper_logs
      WHERE status = 'failure' AND started_at >= ${sixHoursAgo.toISOString()}
      GROUP BY service
    `),
  ]);

  const totals = new Map<string, number>();
  for (const r of totalsRes.rows) {
    const row = r as { service: string; count: number };
    totals.set(row.service, row.count);
  }
  const failures = new Map<string, number>();
  for (const r of failuresRes.rows) {
    const row = r as { service: string; count: number };
    failures.set(row.service, row.count);
  }

  const results: CheckResult[] = [];

  for (const svc of SCRAPER_SERVICES) {
    const total = totals.get(svc.dbValue) ?? 0;
    const failed = failures.get(svc.dbValue) ?? 0;
    const failRate = total > 0 ? ((failed / total) * 100).toFixed(0) : '0';
    const passed = failed <= 3;

    let samples: Record<string, unknown>[] | undefined;
    if (!passed && failed > 0) {
      const sampleRows = await db
        .select({
          status: scraperLogs.status,
          errorMessage: scraperLogs.errorMessage,
          startedAt: scraperLogs.startedAt,
        })
        .from(scraperLogs)
        .where(
          and(
            sql`${scraperLogs.service} = ${svc.dbValue}`,
            eq(scraperLogs.status, 'failure'),
            gte(scraperLogs.startedAt, sixHoursAgo),
          ),
        )
        .orderBy(desc(scraperLogs.startedAt))
        .limit(10);
      samples = sampleRows;
    }

    results.push({
      name: `${svc.key}_failure_rate_6h`,
      passed,
      value: `${failed}/${total} (${failRate}%)`,
      threshold: '≤ 3 failures',
      samples,
    });
  }

  return results;
}

/** Consecutive failures per service (parallelized per-service queries) */
async function checkConsecutiveFailures(): Promise<CheckResult[]> {
  const db = getDb();

  const perService = await Promise.all(
    SCRAPER_SERVICES.map(async (svc) => {
      const rows = await db
        .select({ status: scraperLogs.status, startedAt: scraperLogs.startedAt })
        .from(scraperLogs)
        .where(sql`${scraperLogs.service} = ${svc.dbValue}`)
        .orderBy(desc(scraperLogs.startedAt))
        .limit(10);

      let consecutive = 0;
      for (const r of rows) {
        if (r.status === 'failure') consecutive++;
        else break;
      }

      const hasData = rows.length > 0;
      return {
        name: `${svc.key}_consecutive_failures` as string,
        passed: consecutive < 3,
        value: hasData ? `${consecutive}` : 'no data',
        threshold: '< 3' as string,
        samples:
          consecutive >= 3
            ? (rows.slice(0, consecutive).map((r) => ({
                status: r.status,
                startedAt: r.startedAt.toISOString(),
              })) as Record<string, unknown>[])
            : undefined,
      } satisfies CheckResult;
    }),
  );

  return perService;
}

/** Zero records scraped but status=success (single consolidated query) */
async function checkZeroRecords(): Promise<CheckResult[]> {
  const db = getDb();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const rows = await db.execute(sql`
    SELECT service, records_scraped, started_at
    FROM scraper_logs
    WHERE status = 'success'
      AND started_at >= ${oneHourAgo.toISOString()}
    ORDER BY service, started_at DESC
  `);

  // Group last 5 per service
  const byService = new Map<string, { recordsScraped: number | null; startedAt: string }[]>();
  for (const r of rows.rows) {
    const row = r as { service: string; records_scraped: number | null; started_at: string };
    if (!byService.has(row.service)) byService.set(row.service, []);
    const arr = byService.get(row.service)!;
    if (arr.length < 5) arr.push({ recordsScraped: row.records_scraped, startedAt: row.started_at });
  }

  const results: CheckResult[] = [];

  for (const svc of SCRAPER_SERVICES) {
    const recent = byService.get(svc.dbValue) ?? [];
    const zeroCount = recent.filter((r) => (r.recordsScraped ?? 0) === 0).length;

    results.push({
      name: `${svc.key}_zero_records`,
      passed: zeroCount === 0,
      value: `${zeroCount} of last ${Math.min(recent.length, 5)}`,
      threshold: 'none',
      ...(zeroCount > 0 && {
        samples: recent
          .filter((r) => (r.recordsScraped ?? 0) === 0)
          .map((r) => ({ startedAt: r.startedAt, recordsScraped: r.recordsScraped })),
      }),
    });
  }

  return results;
}

// ── Flight Data Integrity Checks ───────────────────────────────────

/** Flights with null status for today's date */
async function checkNullStatus(): Promise<CheckResult[]> {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const rows = await db
    .select({ id: flights.id, flightNumber: flights.flightNumber, flightDate: flights.flightDate })
    .from(flights)
    .where(and(eq(flights.flightDate, today), sql`${flights.status} IS NULL`))
    .limit(20);

  return [
    {
      name: 'null_status_today',
      passed: rows.length === 0,
      value: rows.length >= 20 ? '20+ flights' : `${rows.length} flights`,
      threshold: 'none',
      ...(rows.length > 0 && {
        samples: rows.map((r) => ({ id: r.id, flightNumber: r.flightNumber, flightDate: r.flightDate })),
      }),
    },
  ];
}

/** Flights with negative delay_minutes (last 7 days) */
async function checkNegativeDelay(): Promise<CheckResult[]> {
  const db = getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const rows = await db
    .select({ id: flights.id, flightNumber: flights.flightNumber, delayMinutes: flights.delayMinutes })
    .from(flights)
    .where(and(gte(flights.flightDate, sevenDaysAgo), sql`${flights.delayMinutes} < 0`))
    .limit(20);

  return [
    {
      name: 'negative_delay',
      passed: rows.length === 0,
      value: rows.length >= 20 ? '20+ flights' : `${rows.length} flights`,
      threshold: 'none',
      ...(rows.length > 0 && {
        samples: rows.map((r) => ({ id: r.id, flightNumber: r.flightNumber, delayMinutes: r.delayMinutes })),
      }),
    },
  ];
}

/** Non-terminal flights with updated_at older than 6 hours (last 7 days) */
async function checkStaleFlights(): Promise<CheckResult[]> {
  const db = getDb();
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const rows = await db
    .select({
      id: flights.id,
      flightNumber: flights.flightNumber,
      status: flights.status,
      updatedAt: flights.updatedAt,
    })
    .from(flights)
    .where(
      and(
        gte(flights.flightDate, sevenDaysAgo),
        sql`${flights.updatedAt} < ${sixHoursAgo.toISOString()}`,
        sql`(${flights.status} IS NULL OR ${flights.status} NOT IN (${sql.join(
          ['Arrived', 'Departed', 'Diverted', 'Cancelled'],
          sql`, `,
        )}))`,
      ),
    )
    .limit(20);

  return [
    {
      name: 'stale_updated_at',
      passed: rows.length === 0,
      value: rows.length >= 20 ? '20+ flights' : `${rows.length} flights`,
      threshold: 'none older than 6h (last 7 days)',
      ...(rows.length > 0 && {
        samples: rows.map((r) => ({
          id: r.id,
          flightNumber: r.flightNumber,
          status: r.status,
          updatedAt: r.updatedAt?.toISOString(),
        })),
      }),
    },
  ];
}

/** Orphaned flight_times with no matching flight_id (last 7 days) */
async function checkOrphanedFlightTimes(): Promise<CheckResult[]> {
  const db = getDb();

  const rows = await db.execute(sql`
    SELECT ft.id, ft.flight_id, ft.time_type, ft.time_value
    FROM flight_times ft
    LEFT JOIN flights f ON ft.flight_id = f.id
    WHERE f.id IS NULL
      AND ft.created_at > NOW() - INTERVAL '7 days'
    LIMIT 20
  `);

  const count = rows.rows.length;

  return [
    {
      name: 'orphaned_flight_times',
      passed: count === 0,
      value: count >= 20 ? '20+ rows' : `${count} rows`,
      threshold: 'none (last 7 days)',
      ...(count > 0 && { samples: rows.rows.slice(0, 20) }),
    },
  ];
}

/** Today's flight count vs 7-day rolling average */
async function checkFlightCountVsAvg(): Promise<CheckResult[]> {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const [todayRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(flights)
    .where(eq(flights.flightDate, today));

  const todayCount = todayRow?.count ?? 0;

  // 7-day avg (excluding today)
  const sevenDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const [avgRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(flights)
    .where(and(gte(flights.flightDate, sevenDaysAgo), sql`${flights.flightDate} < ${today}`));

  const avgCount = avgRow ? Math.round(avgRow.count / 7) : 0;
  const pctOfAvg = avgCount > 0 ? ((todayCount / avgCount) * 100).toFixed(0) : 'N/A';

  return [
    {
      name: 'flight_count_vs_avg',
      passed: avgCount === 0 || todayCount >= avgCount * 0.5,
      value: `${todayCount} today vs ~${avgCount} 7-day avg (${pctOfAvg}%)`,
      threshold: '≥ 50% of avg',
      ...(avgCount > 0 &&
        todayCount < avgCount * 0.5 && {
          samples: [{ todayCount, avgCount, pctOfAvg, dateRange: `${sevenDaysAgo} to ${yesterday}` }],
        }),
    },
  ];
}

// ── Notification Pipeline Checks ──────────────────────────────────

async function checkWatermarkLag(): Promise<CheckResult[]> {
  const db = getDb();

  const [watermark] = await db
    .select({ lastProcessedId: notificationWatermark.lastProcessedId })
    .from(notificationWatermark)
    .limit(1);

  if (!watermark) {
    return [
      {
        name: 'watermark_lag',
        passed: true,
        value: 'no watermark row (not yet initialised)',
        threshold: '≤ 100',
      },
    ];
  }

  const [maxRow] = await db
    .select({ maxId: sql<number>`coalesce(max(id), 0)` })
    .from(flightStatusHistory);

  const maxId = maxRow?.maxId ?? 0;
  const lag = Math.max(0, maxId - watermark.lastProcessedId);

  return [
    {
      name: 'watermark_lag',
      passed: lag <= 100,
      value: `${lag} unprocessed (max=${maxId}, processed=${watermark.lastProcessedId})`,
      threshold: '≤ 100',
      ...(lag > 100 && { samples: [{ maxId, lastProcessedId: watermark.lastProcessedId, lag }] }),
    },
  ];
}

async function checkDeadPushSubs(): Promise<CheckResult[]> {
  const db = getDb();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      flightCode: pushSubscriptions.flightCode,
      flightDate: pushSubscriptions.flightDate,
      createdAt: pushSubscriptions.createdAt,
      lastNotifiedAt: pushSubscriptions.lastNotifiedAt,
    })
    .from(pushSubscriptions)
    .where(
      and(
        sql`${pushSubscriptions.lastNotifiedAt} IS NULL`,
        sql`${pushSubscriptions.createdAt} < ${oneDayAgo.toISOString()}`,
      ),
    )
    .limit(20);

  return [
    {
      name: 'dead_push_subs',
      passed: rows.length === 0,
      value: `${rows.length} subscriptions`,
      threshold: 'none',
      ...(rows.length > 0 && {
        samples: rows.slice(0, 20).map((r) => ({
          id: r.id,
          flightCode: r.flightCode,
          flightDate: r.flightDate,
          createdAt: r.createdAt?.toISOString(),
        })),
      }),
    },
  ];
}

// ── Weather & Position Gap Checks ──────────────────────────────────

/** Weather gap per airport — max gap (single query with PARTITION BY) */
async function checkWeatherGaps(): Promise<CheckResult[]> {
  const db = getDb();
  const gapThresholdMins = parseInt(process.env.WEATHER_GAP_THRESHOLD_MINS ?? '120', 10);

  const gaps = await db.execute(sql`
    WITH ordered AS (
      SELECT
        airport_code,
        timestamp,
        LAG(timestamp) OVER (PARTITION BY airport_code ORDER BY timestamp) AS prev_ts
      FROM weather_data
      WHERE timestamp > NOW() - INTERVAL '24 hours'
    ),
    gap_calc AS (
      SELECT
        airport_code,
        EXTRACT(EPOCH FROM (timestamp - prev_ts)) / 60 AS gap_mins,
        prev_ts,
        timestamp
      FROM ordered
      WHERE prev_ts IS NOT NULL
    ),
    max_gaps AS (
      SELECT DISTINCT ON (airport_code)
        airport_code,
        gap_mins,
        prev_ts,
        timestamp
      FROM gap_calc
      ORDER BY airport_code, gap_mins DESC
    )
    SELECT airport_code, gap_mins, prev_ts, timestamp
    FROM max_gaps
    ORDER BY gap_mins DESC
  `);

  const results: CheckResult[] = [];

  for (const r of gaps.rows) {
    const row = r as { airport_code: string; gap_mins: number; prev_ts: string; timestamp: string };
    const gapMins = Math.round(row.gap_mins);

    results.push({
      name: `weather_gap_${row.airport_code}`,
      passed: gapMins < gapThresholdMins,
      value: `${gapMins}min max gap`,
      threshold: `< ${gapThresholdMins}min`,
      ...(gapMins >= gapThresholdMins && {
        samples: [
          {
            airportCode: row.airport_code,
            prevTs: row.prev_ts,
            nextTs: row.timestamp,
            gapMins,
          },
        ],
      }),
    });
  }

  if (results.length === 0) {
    results.push({
      name: 'weather_gaps',
      passed: true,
      value: 'no airports with data in last 24h',
      threshold: `< ${gapThresholdMins}min`,
    });
  }

  return results;
}

/** Position gap — max gap between consecutive timestamps */
async function checkPositionGaps(): Promise<CheckResult[]> {
  const db = getDb();
  const gapThresholdMins = parseInt(process.env.POSITION_GAP_THRESHOLD_MINS ?? '60', 10);

  const gaps = await db.execute(sql`
    WITH ordered AS (
      SELECT
        position_timestamp,
        LAG(position_timestamp) OVER (ORDER BY position_timestamp) AS prev_ts
      FROM aircraft_positions
      WHERE fetched_at > NOW() - INTERVAL '24 hours'
    )
    SELECT
      EXTRACT(EPOCH FROM (position_timestamp - prev_ts)) / 60 AS gap_mins
    FROM ordered
    WHERE prev_ts IS NOT NULL
    ORDER BY gap_mins DESC
    LIMIT 1
  `);

  const gap = gaps.rows[0] as { gap_mins: number } | undefined;
  const gapMins = gap ? Math.round(gap.gap_mins) : 0;

  const passed = gaps.rows.length === 0 || gapMins < gapThresholdMins;

  return [
    {
      name: 'position_gap',
      passed,
      value: gap ? `${gapMins}min max gap` : 'no positions in last 24h',
      threshold: `< ${gapThresholdMins}min`,
      ...(gap && gapMins >= gapThresholdMins && { samples: [{ gapMins }] }),
    },
  ];
}

/** Stale weather — newest entry per airport (single query with DISTINCT ON) */
async function checkStaleWeatherCheck(): Promise<CheckResult[]> {
  const db = getDb();
  const staleThresholdMins = parseInt(process.env.STALE_WEATHER_THRESHOLD_MINS ?? '180', 10);
  const now = new Date();

  const rows = await db.execute(sql`
    SELECT DISTINCT ON (wd.airport_code) wd.airport_code, wd.timestamp
    FROM weather_data wd
    INNER JOIN flights f ON (
      f.departure_airport = wd.airport_code OR f.arrival_airport = wd.airport_code
    )
    WHERE f.flight_date >= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY wd.airport_code, wd.timestamp DESC
  `);

  const results: CheckResult[] = [];

  for (const r of rows.rows) {
    const row = r as { airport_code: string; timestamp: string };
    const ageMs = now.getTime() - new Date(row.timestamp).getTime();
    const ageMins = Math.round(ageMs / 60000);

    results.push({
      name: `stale_weather_${row.airport_code}`,
      passed: ageMins < staleThresholdMins,
      value: `${ageMins}m ago`,
      threshold: `< ${staleThresholdMins}min`,
      ...(ageMins >= staleThresholdMins && {
        samples: [{ airportCode: row.airport_code, newestTimestamp: row.timestamp, ageMins }],
      }),
    });
  }

  if (results.length === 0) {
    results.push({
      name: 'stale_weather',
      passed: true,
      value: 'no weather data',
      threshold: `< ${staleThresholdMins}min`,
    });
  }

  return results;
}

// ── Aggregated Runners ─────────────────────────────────────────────

export async function runScraperChecks(): Promise<CheckResult[]> {
  return safeCheck('scraper_checks', 'varies', async () => {
    const [staleness, failureRate, consecutive, zeroRecords] = await Promise.all([
      checkScraperStaleness(),
      checkScraperFailureRate(),
      checkConsecutiveFailures(),
      checkZeroRecords(),
    ]);
    return [...staleness, ...failureRate, ...consecutive, ...zeroRecords];
  });
}

export async function runFlightChecks(): Promise<CheckResult[]> {
  return safeCheck('flight_integrity', 'varies', async () => {
    const [nullStatus, negativeDelay, stale, orphaned, countVsAvg] = await Promise.all([
      checkNullStatus(),
      checkNegativeDelay(),
      checkStaleFlights(),
      checkOrphanedFlightTimes(),
      checkFlightCountVsAvg(),
    ]);
    return [...nullStatus, ...negativeDelay, ...stale, ...orphaned, ...countVsAvg];
  });
}

export async function runNotificationChecks(): Promise<CheckResult[]> {
  return safeCheck('notification_pipeline', 'varies', async () => {
    const [watermarkLag, deadSubs] = await Promise.all([checkWatermarkLag(), checkDeadPushSubs()]);
    return [...watermarkLag, ...deadSubs];
  });
}

export async function runWeatherPositionChecks(): Promise<CheckResult[]> {
  return safeCheck('weather_position', 'varies', async () => {
    const [weatherGaps, positionGaps, staleWeather] = await Promise.all([
      checkWeatherGaps(),
      checkPositionGaps(),
      checkStaleWeatherCheck(),
    ]);
    return [...weatherGaps, ...positionGaps, ...staleWeather];
  });
}

export async function runAllChecks(): Promise<CheckResult[]> {
  const [scraper, flight, notification, weatherPosition] = await Promise.all([
    runScraperChecks(),
    runFlightChecks(),
    runNotificationChecks(),
    runWeatherPositionChecks(),
  ]);
  return [...scraper, ...flight, ...notification, ...weatherPosition];
}
