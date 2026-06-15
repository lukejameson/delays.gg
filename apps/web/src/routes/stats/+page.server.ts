import { db } from '$lib/server/db';
import { sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import {
  getFilterOptions,
  getHeroStats,
  getDelayDistribution,
  getDayOfWeekDistribution,
  getHourDistribution,
  getBusiestDays,
  getWorstDays,
  getRouteStats,
  getFlightNumberStats,
  getAircraftStats,
  getTopDelays,
  getDailyOtpStats,
  getMonthlyBreakdown,
  getWindDelayStats,
  getVisibilityDelayStats,
  getPrecipitationDelayStats,
  getWeatherCodeDelayStats,
  getCrosswindDelayStats,
  getWorstWeatherDays,
  getDelayImpact,
  getWorstDelayDays,
} from './lib/queries';
import type { FilterConfig } from './lib/types';

export const load: PageServerLoad = async ({ url }) => {
  const range = url.searchParams.get('range') ?? '90';
  const dateFrom = url.searchParams.get('dateFrom') ?? '';
  const dateTo = url.searchParams.get('dateTo') ?? '';
  const activeAirline = url.searchParams.get('airline') ?? '';
  // Support multiple routes: ?route=GCI-LGW&route=GCI-EXT
  const activeRoutes = url.searchParams.getAll('route').filter(Boolean);
  const activeDirection = url.searchParams.get('direction') ?? '';
  const activeDow = url.searchParams.get('dow') ?? '';
  const activeSeason = url.searchParams.get('season') ?? '';
  const activeMonth = url.searchParams.get('month') ?? '';
  const activeYear = url.searchParams.get('year') ?? '';
  const thresholdParam = parseInt(url.searchParams.get('threshold') ?? '15', 10);
  const threshold = [0, 15, 30].includes(thresholdParam) ? thresholdParam : 15;
  const minFlightsPerRoute = range === '30' ? 2 : range === '90' ? 3 : 5;

  // Parse multiple routes into array of {dep, arr} objects
  const parsedRoutes = activeRoutes.map(r => {
    const parts = r.split('-');
    const dep = parts[0] ?? '';
    const arr = parts.slice(1).join('-');
    return { dep, arr, key: r };
  }).filter(r => r.dep && r.arr);

  // Get available years, airlines, and routes for filters
  const [yearsResult, airlinesResult, routesResult] = await Promise.all([
    db.execute(sql`SELECT DISTINCT EXTRACT(YEAR FROM flight_date)::int as year FROM flights WHERE flight_date IS NOT NULL ORDER BY year DESC`),
    db.execute(sql`SELECT DISTINCT UPPER(SUBSTRING(flight_number FROM 1 FOR 2)) as code FROM flights WHERE flight_number IS NOT NULL AND flight_number ~ '^[A-Za-z]{2}' ORDER BY code`),
    db.execute(sql`
      SELECT
        f.departure_airport,
        f.arrival_airport,
        f.departure_airport || '-' || f.arrival_airport AS route_key,
        COUNT(*) AS flight_count
      FROM flights f
      WHERE f.departure_airport != f.arrival_airport AND f.departure_airport IS NOT NULL AND f.arrival_airport IS NOT NULL
      GROUP BY f.departure_airport, f.arrival_airport
      ORDER BY flight_count DESC
    `)
  ]);
  const availableYears = (yearsResult.rows as { year: number }[]).map(r => r.year);
  const availableAirlines = (airlinesResult.rows as { code: string }[]).map(r => r.code);
  const availableRoutes = (routesResult.rows as { departure_airport: string; arrival_airport: string; route_key: string }[]).map(r => ({
    departure: r.departure_airport,
    arrival: r.arrival_airport,
    key: r.route_key,
  }));

  // LM (Loganair) and SI (Blue Islands) are codeshares with Aurigny (GR) on Guernsey routes.
  // Their flight records are stored under the primary GR code, so we map them to GR.
  const resolveAirlineCode = (code: string) => code === 'LM' || code === 'SI' ? 'GR' : code;
  const airlineFilter = activeAirline
    ? sql`(UPPER(SUBSTRING(f.flight_number FROM 1 FOR 2)) = ${resolveAirlineCode(activeAirline)})`
    : sql`(f.flight_number ILIKE 'GR%' OR f.flight_number ILIKE 'BA%')`;

  // Build date filter based on range selection or custom dates
  let dateFilter;
  if (range === 'custom' && dateFrom && dateTo) {
    dateFilter = sql`AND f.flight_date BETWEEN ${dateFrom} AND ${dateTo}`;
  } else if (range === '30') {
    dateFilter = sql`AND f.flight_date >= CURRENT_DATE - INTERVAL '30 days'`;
  } else if (range === '90') {
    dateFilter = sql`AND f.flight_date >= CURRENT_DATE - INTERVAL '90 days'`;
  } else {
    dateFilter = sql``;
  }

  // Subquery (alias f2) computes the set of regular routes for this period.
  const routeMinDateFilter = range === 'custom' && dateFrom && dateTo
    ? sql`AND f2.flight_date BETWEEN ${dateFrom} AND ${dateTo}`
    : range === '30'
      ? sql`AND f2.flight_date >= CURRENT_DATE - INTERVAL '30 days'`
      : range === '90'
        ? sql`AND f2.flight_date >= CURRENT_DATE - INTERVAL '90 days'`
        : sql``;

  const routeMinFilter = sql`AND (f.departure_airport, f.arrival_airport) IN (
    SELECT f2.departure_airport, f2.arrival_airport FROM flights f2
    WHERE (f2.flight_number ILIKE 'GR%' OR f2.flight_number ILIKE 'BA%')
      AND f2.departure_airport != f2.arrival_airport
      ${routeMinDateFilter}
    GROUP BY f2.departure_airport, f2.arrival_airport
    HAVING COUNT(*) >= ${minFlightsPerRoute}
  )`;

  const routeFilter = parsedRoutes.length > 0
    ? sql`AND (f.departure_airport, f.arrival_airport) IN (${sql.join(parsedRoutes.map(r => sql`(${r.dep}, ${r.arr})`), sql`, `)})`
    : sql``;

  const directionFilter = activeDirection === 'dep'
    ? sql`AND f.departure_airport = 'GCI'`
    : activeDirection === 'arr'
    ? sql`AND f.arrival_airport = 'GCI'`
    : sql``;

  const dowNum = parseInt(activeDow, 10);
  const monthNum = parseInt(activeMonth, 10);
  const yearNum = parseInt(activeYear, 10);

  // Build filter configuration
  const filterConfig: FilterConfig = {
    range: {
      type: range as '30' | '90' | 'custom' | 'all',
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    },
    airline: activeAirline || undefined,
    routes: parsedRoutes.length > 0 ? parsedRoutes : undefined,
    direction: activeDirection as 'dep' | 'arr' | '' || undefined,
    dow: activeDow !== '' && !isNaN(dowNum) && dowNum >= 0 && dowNum <= 6 ? dowNum : undefined,
    season: activeSeason as 'summer' | 'winter' | 'spring' | 'autumn' | '' || undefined,
    month: activeMonth !== '' && !isNaN(monthNum) && monthNum >= 1 && monthNum <= 12 ? monthNum : undefined,
    year: activeYear !== '' && !isNaN(yearNum) && yearNum >= 2000 && yearNum <= 2100 ? yearNum : undefined,
    threshold,
    minFlightsPerRoute,
  };

  // Get filter options and all stats data in parallel
  const [
    filterOptions,
    heroStats,
    delayDistribution,
    dayOfWeek,
    departureHour,
    busiestDays,
    worstDays,
    worstRoutes,
    flightNumbers,
    aircraftUsage,
    topDelays,
    dailyOtp,
    monthlyBreakdown,
    windDelays,
    visibilityDelays,
    precipDelays,
    weatherCodeDelays,
    crosswindDelays,
    worstWeatherDays,
    delayImpact,
    worstDelayDays,
  ] = await Promise.all([
    getFilterOptions().catch((e) => { console.error('[Stats] getFilterOptions failed:', e); return { availableYears: [] as number[], availableAirlines: [] as string[], availableRoutes: [] as Array<{ departure: string; arrival: string; key: string }> }; }),
    getHeroStats(filterConfig).catch((e) => { console.error('[Stats] getHeroStats failed:', e); return { total_flights: 0, total_cancelled: 0, operated: 0, with_outcome: 0, on_time: 0, delayed: 0, avg_delay_mins: null, earliest_date: null, latest_date: null }; }),
    getDelayDistribution(filterConfig).catch((e) => { console.error('[Stats] getDelayDistribution failed:', e); return { on_time: 0, d1_15: 0, d16_30: 0, d31_60: 0, d1_2h: 0, d2hplus: 0, cancelled: 0, no_outcome: 0 }; }),
    getDayOfWeekDistribution(filterConfig).catch((e) => { console.error('[Stats] getDayOfWeekDistribution failed:', e); return []; }),
    getHourDistribution(filterConfig).catch((e) => { console.error('[Stats] getHourDistribution failed:', e); return []; }),
    getBusiestDays(filterConfig, 10).catch((e) => { console.error('[Stats] getBusiestDays failed:', e); return []; }),
    getWorstDays(filterConfig, 10).catch((e) => { console.error('[Stats] getWorstDays failed:', e); return []; }),
    getRouteStats(filterConfig).catch((e) => { console.error('[Stats] getRouteStats failed:', e); return []; }),
    getFlightNumberStats(filterConfig, 20).catch((e) => { console.error('[Stats] getFlightNumberStats failed:', e); return []; }),
    getAircraftStats(filterConfig).catch((e) => { console.error('[Stats] getAircraftStats failed:', e); return []; }),
    getTopDelays(filterConfig, 10).catch((e) => { console.error('[Stats] getTopDelays failed:', e); return []; }),
    getDailyOtpStats(filterConfig).catch((e) => { console.error('[Stats] getDailyOtpStats failed:', e); return []; }),
    getMonthlyBreakdown(filterConfig).catch((e) => { console.error('[Stats] getMonthlyBreakdown failed:', e); return []; }),
    getWindDelayStats(filterConfig).catch((e) => { console.error('[Stats] getWindDelayStats failed:', e); return []; }),
    getVisibilityDelayStats(filterConfig).catch((e) => { console.error('[Stats] getVisibilityDelayStats failed:', e); return []; }),
    getPrecipitationDelayStats(filterConfig).catch((e) => { console.error('[Stats] getPrecipitationDelayStats failed:', e); return []; }),
    getWeatherCodeDelayStats(filterConfig).catch((e) => { console.error('[Stats] getWeatherCodeDelayStats failed:', e); return []; }),
    getCrosswindDelayStats(filterConfig).catch((e) => { console.error('[Stats] getCrosswindDelayStats failed:', e); return []; }),
    getWorstWeatherDays(filterConfig, 10).catch((e) => { console.error('[Stats] getWorstWeatherDays failed:', e); return []; }),
    getDelayImpact(filterConfig).catch((e) => { console.error('[Stats] getDelayImpact failed:', e); return { total_delay_mins: null, flights_delayed_gt5: 0, total_delay_mins_gt5: 0, operated: 0, total: 0, cancelled: 0, avg_delay_when_delayed: null, avg_delay_all_operated: null, pax_weighted_delay_mins: null }; }),
    getWorstDelayDays(filterConfig, 10).catch((e) => { console.error('[Stats] getWorstDelayDays failed:', e); return []; }),
  ]);

  const wxFlightCount = (windDelays as { flights: unknown }[]).reduce(
    (s, r) => s + Number(r.flights),
    0,
  );

  return {
    range,
    dateFrom,
    dateTo,
    activeAirline,
    activeRoutes,
    activeDirection,
    activeDow,
    activeSeason,
    activeMonth,
    activeYear,
    threshold,
    availableYears: filterOptions.availableYears,
    availableAirlines: filterOptions.availableAirlines,
    availableRoutes: filterOptions.availableRoutes,
    heroStats,
    delayDistribution,
    dayOfWeek,
    departureHour,
    busiestDays,
    worstDays,
    worstRoutes,
    flightNumbers,
    aircraftUsage,
    topDelays,
    dailyOtp,
    monthlyBreakdown,
    windDelays,
    visibilityDelays,
    precipDelays,
    weatherCodeDelays,
    crosswindDelays,
    worstWeatherDays,
    wxFlightCount,
    delayImpact,
    worstDelayDays,
  };
};
