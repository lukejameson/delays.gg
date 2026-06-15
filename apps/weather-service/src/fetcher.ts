import { db, weatherData, flights, airportDaylight, airports, guernseyTodayStr, guernseyTomorrowStr } from '@airways/database';
import { sql, inArray } from 'drizzle-orm';
import { getIcaoMapping } from './airports';
import SunCalc from 'suncalc';
import { sendAlert } from '@airways/telegram';

const AVIATION_WEATHER_BASE = 'https://aviationweather.gov/api/data';
const BATCH_SIZE = 50;

interface WeatherRow {
  airportCode: string;
  timestamp: Date;
  temperature: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  visibility: number | null;
  cloudCover: number;
  pressure: number | null;
  weatherCode: number;
}

interface ParsedConditions {
  temp?: number;
  dewp?: number;
  wdir?: number;
  wspd?: number;
  visib?: number;
  pressure?: number;
  cover?: Array<{ layer: string; base: number }>;
}

function parseWeatherString(text: string): ParsedConditions {
  const result: ParsedConditions = {};
  const parts = text.split(' ');
  
  for (const part of parts) {
    // Temperature (e.g., 15/07 or M02/M04 for negative)
    const tempMatch = part.match(/^(M?\d{2})\/(M?\d{2})$/);
    if (tempMatch) {
      result.temp = parseInt(tempMatch[1].replace('M', '-'));
      result.dewp = parseInt(tempMatch[2].replace('M', '-'));
      continue;
    }
    
    // Wind (e.g., 24006KT, VRB04KT, or 24006G12KT with gusts)
    const windMatch = part.match(/^(\d{3}|VRB)(\d{2,3})(?:G\d{2,3})?KT$/);
    if (windMatch) {
      result.wdir = windMatch[1] === 'VRB' ? 0 : parseInt(windMatch[1]);
      result.wspd = parseInt(windMatch[2]);
      continue;
    }
    
    // Pressure (e.g., Q1016)
    const pressureMatch = part.match(/^Q(\d{4})$/);
    if (pressureMatch) {
      result.pressure = parseInt(pressureMatch[1]);
      continue;
    }
    
    // Visibility (e.g., 9999, 5000, or 1/2SM, 3SM for statute miles)
    if (/^\d{4}$/.test(part) && !part.startsWith('Q')) {
      const vis = parseInt(part);
      if (vis >= 1000 && vis <= 9999) {
        result.visib = vis >= 9999 ? 10 : vis / 1000;
      }
      continue;
    }
    
    // CAVOK (Ceiling And Visibility OK)
    if (part === 'CAVOK') {
      result.visib = 10;
    }
    
    // Cloud layers (e.g., FEW020, SCT030, BKN050, OVC100, NSC)
    const cloudMatch = part.match(/^(FEW|SCT|BKN|OVC)(\d{3})$/);
    if (cloudMatch) {
      if (!result.cover) result.cover = [];
      result.cover.push({
        layer: cloudMatch[1],
        base: parseInt(cloudMatch[2]) * 100,
      });
    } else if (part === 'NSC') {
      // No significant clouds
      result.cover = [];
    }
  }
  
  return result;
}

function getCloudCoverPercent(data: ParsedConditions): number {
  if (!data.cover || data.cover.length === 0) {
    // No cloud layer data parsed — assume clear (CAVOK or NSC were set)
    return 0;
  }
  
  const layerCoverage: Record<string, number> = {
    'FEW': 25,
    'SCT': 50,
    'BKN': 75,
    'OVC': 100,
  };
  
  let maxCover = 0;
  for (const layer of data.cover) {
    maxCover = Math.max(maxCover, layerCoverage[layer.layer] || 0);
  }
  
  return maxCover;
}

function getWeatherCode(cloudCover: number): number {
  if (cloudCover === 0) return 0;
  if (cloudCover <= 25) return 1;
  if (cloudCover < 50) return 2;
  return 3;
}

// Batch insert weather data efficiently
async function batchInsertWeather(rows: WeatherRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  
  // Deduplicate rows by airport_code + timestamp
  // Keep the last occurrence (most recent data wins)
  const uniqueRows = new Map<string, WeatherRow>();
  for (const row of rows) {
    const key = `${row.airportCode}|${row.timestamp.toISOString()}`;
    uniqueRows.set(key, row);
  }
  
  const deduplicatedRows = Array.from(uniqueRows.values());
  
  if (deduplicatedRows.length !== rows.length) {
    console.log(`[Weather] Deduplicated ${rows.length} rows to ${deduplicatedRows.length} unique rows`);
  }
  
  // Use a single insert with multiple values
  const values = deduplicatedRows.map(r => ({
    airportCode: r.airportCode,
    timestamp: r.timestamp,
    temperature: r.temperature,
    windSpeed: r.windSpeed,
    windDirection: r.windDirection,
    visibility: r.visibility,
    cloudCover: r.cloudCover,
    pressure: r.pressure,
    weatherCode: r.weatherCode,
  }));
  
  // Insert in batches
  let inserted = 0;
  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const batch = values.slice(i, i + BATCH_SIZE);
    await db.insert(weatherData).values(batch).onConflictDoUpdate({
      target: [weatherData.airportCode, weatherData.timestamp],
      set: {
        temperature: sql`EXCLUDED.temperature`,
        windSpeed: sql`EXCLUDED.wind_speed`,
        windDirection: sql`EXCLUDED.wind_direction`,
        visibility: sql`EXCLUDED.visibility`,
        cloudCover: sql`EXCLUDED.cloud_cover`,
        pressure: sql`EXCLUDED.pressure`,
        weatherCode: sql`EXCLUDED.weather_code`,
      },
    });
    inserted += batch.length;
  }
  
  return inserted;
}

async function fetchAllMetars(airports: { code: string; icao: string }[]): Promise<Map<string, ParsedConditions>> {
  const icaos = airports.map(a => a.icao).join(',');
  const url = `${AVIATION_WEATHER_BASE}/metar?ids=${icaos}&hours=1`;
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AviationWeather METAR ${res.status}`);
  
  const text = await res.text();
  const results = new Map<string, ParsedConditions>();
  
  const lines = text.trim().split('\n').filter(l => l.trim());
  for (const line of lines) {
    // Extract ICAO code (first word after optional METAR)
    const match = line.match(/^(?:METAR\s+)?(\w{4})\s+/);
    if (!match) continue;
    
    const icao = match[1];
    const data = parseWeatherString(line);
    if (data.temp != null) {
      results.set(icao, data);
    }
  }
  
  return results;
}

async function fetchTafBatch(icaos: string[], airportByIcao: Map<string, { code: string; icao: string }>, retries = 2): Promise<Map<string, WeatherRow[]>> {
  const url = `${AVIATION_WEATHER_BASE}/taf?ids=${icaos.join(',')}&hours=24`;

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`AviationWeather TAF ${res.status}`);
      return parseTafResponse(await res.text(), airportByIcao);
    } catch (err) {
      lastErr = err as Error;
      if (attempt < retries) {
        const delay = (attempt + 1) * 2000;
        console.log(`[Weather] TAF fetch attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function fetchAllTafs(airports: { code: string; icao: string }[]): Promise<Map<string, WeatherRow[]>> {
  const airportByIcao = new Map(airports.map(a => [a.icao, a]));
  const icaos = airports.map(a => a.icao);

  // Fetch in batches of 5 ICAOs to reduce request size and timeout risk
  const BATCH = 5;
  const results = new Map<string, WeatherRow[]>();
  for (let i = 0; i < icaos.length; i += BATCH) {
    const batch = icaos.slice(i, i + BATCH);
    try {
      const batchResults = await fetchTafBatch(batch, airportByIcao);
      for (const [code, forecasts] of batchResults) {
        results.set(code, forecasts);
      }
    } catch (err) {
      console.error(`[Weather] TAF batch ${i}-${i + batch.length} failed after retries:`, (err as Error).message);
      // Continue with other batches — don't lose data from successful ones
    }
  }
  return results;
}

function parseTafResponse(text: string, airportByIcao: Map<string, { code: string; icao: string }>): Map<string, WeatherRow[]> {
  const results = new Map<string, WeatherRow[]>();
  const now = new Date();
  let currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth();
  const currentDay = now.getUTCDate();

  // TAFs are returned one per line, but may have continuation lines (indented)
  // Split into individual TAFs by finding lines that start with "TAF "
  const lines = text.split('\n');
  const tafs: string[] = [];
  let currentTaf = '';

  for (const line of lines) {
    if (line.startsWith('TAF ')) {
      // Save previous TAF if exists
      if (currentTaf) {
        tafs.push(currentTaf.trim());
      }
      currentTaf = line;
    } else if (line.trim().startsWith('TAF ') && !currentTaf) {
      // Handle case where TAF starts after whitespace
      if (currentTaf) {
        tafs.push(currentTaf.trim());
      }
      currentTaf = line.trim();
    } else if (currentTaf) {
      // Continuation line - append to current TAF
      currentTaf += ' ' + line.trim();
    }
  }
  // Don't forget the last TAF
  if (currentTaf) {
    tafs.push(currentTaf.trim());
  }

  console.log(`[Weather] Parsed ${tafs.length} TAFs from response`);

  for (const tafText of tafs) {
    // Extract ICAO from the TAF header
    const headerMatch = tafText.match(/^TAF\s+(\w{4})/);
    if (!headerMatch) continue;

    const icao = headerMatch[1];
    const airport = airportByIcao.get(icao);
    if (!airport) {
      console.log(`[Weather] Unknown ICAO in TAF: ${icao}`);
      continue;
    }
    
    const forecasts: WeatherRow[] = [];

    // Parse the main forecast period from the TAF
    // Main forecast period: DDHH/DDHH
    const periodMatch = tafText.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})\s+(.+?)(?:\s+(?:BECMG|TEMPO|FM|PROB)\s|$)/);
    if (!periodMatch) continue;

    const startDay = parseInt(periodMatch[1]);
    const startHour = parseInt(periodMatch[2]);
    const endDay = parseInt(periodMatch[3]);
    const endHour = parseInt(periodMatch[4]);
    let conditionsText = periodMatch[5];

    // Handle month rollover — use local variables so the outer currentYear/Month
    // are never mutated (a previous bug caused all subsequent TAFs in the same
    // response to use the wrong year once a single TAF triggered a year increment).
    let tafYear = currentYear;
    let startMonth = currentMonth;
    let endMonth = currentMonth;

    if (startDay < currentDay && currentDay > 25) {
      startMonth = (currentMonth + 1) % 12;
      if (startMonth === 0) tafYear++;
    }
    if (endDay < startDay) {
      endMonth = (startMonth + 1) % 12;
    }

    const startDate = new Date(Date.UTC(tafYear, startMonth, startDay, startHour));
    const endDate = new Date(Date.UTC(tafYear, endMonth, endDay, endHour));

    // Check for BECMG (becoming) - gradual change during period
    const becmgMatch = tafText.match(/BECMG\s+(\d{2})(\d{2})\/(\d{2})(\d{2})\s+(.+)/);
    if (becmgMatch) {
      // Use the becoming conditions for the latter part of the period
      conditionsText = becmgMatch[5];
    }

    const data = parseWeatherString(conditionsText);
    const cloudCover = getCloudCoverPercent(data);

    // Generate hourly forecasts
    const hour = new Date(startDate);
    while (hour < endDate) {
      forecasts.push({
        airportCode: airport.code,
        timestamp: new Date(hour),
        temperature: data.temp ?? null,
        windSpeed: data.wspd ?? null,
        windDirection: data.wdir ?? null,
        visibility: data.visib ?? null,
        cloudCover,
        pressure: data.pressure ?? null,
        weatherCode: getWeatherCode(cloudCover),
      });
      hour.setHours(hour.getHours() + 1);
    }
    
    if (forecasts.length > 0) {
      results.set(airport.code, forecasts);
    }
  }
  
  return results;
}

async function getAirportsFromFlights(): Promise<{ code: string; icao: string }[]> {
  const now = new Date();
  const todayStr = guernseyTodayStr(now);
  const tomorrowStr = guernseyTomorrowStr(now);

  // Query unique airports from today's AND tomorrow's flights by Guernsey date
  const todaysFlights = await db
    .select({
      departureAirport: flights.departureAirport,
      arrivalAirport: flights.arrivalAirport,
    })
    .from(flights)
    .where(
      sql`${flights.flightDate} IN (${todayStr}, ${tomorrowStr})`
    );

  // Collect unique airport codes
  const airportCodes = new Set<string>();
  for (const flight of todaysFlights) {
    airportCodes.add(flight.departureAirport);
    airportCodes.add(flight.arrivalAirport);
  }

  const icaoMapping = await getIcaoMapping(Array.from(airportCodes));
  
  const airports: { code: string; icao: string }[] = [];
  for (const code of airportCodes) {
    const icao = icaoMapping.get(code);
    if (icao) {
      airports.push({ code, icao });
    } else {
      console.log(`[Weather] No ICAO mapping for airport: ${code}`);
    }
  }

  return airports;
}

interface AirportLocation {
  code: string;
  latitude: number;
  longitude: number;
}

async function fetchAirportLocations(airportCodes: string[]): Promise<AirportLocation[]> {
  if (airportCodes.length === 0) return [];
  
  const rows = await db
    .select({
      code: airports.iataCode,
      latitude: airports.latitude,
      longitude: airports.longitude,
    })
    .from(airports)
    .where(inArray(airports.iataCode, airportCodes));
  
  return rows
    .filter(row => row.latitude != null && row.longitude != null)
    .map(row => ({
      code: row.code,
      latitude: row.latitude!,
      longitude: row.longitude!,
    }));
}

async function calculateAndStoreDaylight(airportLocations: AirportLocation[]): Promise<void> {
  if (airportLocations.length === 0) return;

  // Get current UTC time
  const now = new Date();

  // Use solar noon (12:00 UTC) rather than midnight when calling SunCalc.
  // Passing midnight UTC causes SunCalc to return times for the previous calendar
  // day — the library interprets the date at the local solar position, so noon is
  // the safest anchor point to guarantee the correct calendar day is used.
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 12, 0, 0));

  // Format date to YYYY-MM-DD string for the date column
  const formatDate = (d: Date): string => d.toISOString().split('T')[0];

  const daylightRows: {
    airportCode: string;
    date: string;
    sunrise: Date;
    sunset: Date;
  }[] = [];

  for (const airport of airportLocations) {
    // SunCalc.getTimes() already returns standard JS Date objects (UTC-based).
    // No conversion needed — do NOT apply getTimezoneOffset(); doing so was a
    // double-conversion bug that shifted times by ±60 min during BST.
    const todayTimes = SunCalc.getTimes(today, airport.latitude, airport.longitude);
    const tomorrowTimes = SunCalc.getTimes(tomorrow, airport.latitude, airport.longitude);

    const todaySunriseUtc = todayTimes.sunrise;
    const todaySunsetUtc = todayTimes.sunset;
    const tomorrowSunriseUtc = tomorrowTimes.sunrise;
    const tomorrowSunsetUtc = tomorrowTimes.sunset;

    daylightRows.push({
      airportCode: airport.code,
      date: formatDate(today),
      sunrise: todaySunriseUtc,
      sunset: todaySunsetUtc,
    });

    daylightRows.push({
      airportCode: airport.code,
      date: formatDate(tomorrow),
      sunrise: tomorrowSunriseUtc,
      sunset: tomorrowSunsetUtc,
    });
  }
  
  // Batch upsert using raw SQL for efficiency
  for (const row of daylightRows) {
    await db.insert(airportDaylight)
      .values(row)
      .onConflictDoUpdate({
        target: [airportDaylight.airportCode, airportDaylight.date],
        set: {
          sunrise: sql`EXCLUDED.sunrise`,
          sunset: sql`EXCLUDED.sunset`,
          createdAt: new Date(),
        },
      });
  }
  
  console.log(`[Weather] Stored daylight data for ${airportLocations.length} airports`);
}

export async function fetchAllWeather(): Promise<void> {
  // Get airports dynamically from today's flights
  const airportsList = await getAirportsFromFlights();
  
  if (airportsList.length === 0) {
    console.log('[Weather] No airports found in today\'s flights');
    return;
  }

  console.log(`[Weather] Fetching aviation weather for ${airportsList.length} airports: ${airportsList.map(a => a.code).join(', ')}`);
  
  // Calculate and store sunrise/sunset times for all airports
  const airportCodes = airportsList.map(a => a.code);
  const airportLocations = await fetchAirportLocations(airportCodes);
  await calculateAndStoreDaylight(airportLocations);
  
  // ── METAR (current conditions) ────────────────────────────────────
  let metarCount = 0;
  try {
    console.log('[Weather] Fetching METARs...');
    const metars = await fetchAllMetars(airportsList);
    console.log(`[Weather] Received ${metars.size} METARs`);
    
    const metarRows: WeatherRow[] = [];
    const now = new Date();
    
    for (const airport of airportsList) {
      const data = metars.get(airport.icao);
      if (!data || data.temp == null) {
        console.log(`[Weather] No METAR for ${airport.code}`);
        continue;
      }
      
      const cloudCover = getCloudCoverPercent(data);
      metarRows.push({
        airportCode: airport.code,
        timestamp: now,
        temperature: data.temp,
        windSpeed: data.wspd ?? null,
        windDirection: data.wdir ?? null,
        visibility: data.visib ?? null,
        cloudCover,
        pressure: data.pressure ?? null,
        weatherCode: getWeatherCode(cloudCover),
      });
      
      console.log(`[Weather] ${airport.code}: ${cloudCover}% cloud, ${data.temp}°C`);
    }
    
    metarCount = await batchInsertWeather(metarRows);
    console.log(`[Weather] Inserted ${metarCount} METAR records`);
  } catch (err) {
    console.error('[Weather] METAR fetch failed:', err);
    sendAlert('weather-service', 'warning', 'METAR fetch failed', err).catch(() => {});
    // Don't throw — TAF may still work
  }

  // ── TAF (forecasts) ───────────────────────────────────────────────
  let tafCount = 0;
  try {
    console.log('[Weather] Fetching TAFs...');
    const tafs = await fetchAllTafs(airportsList);
    console.log(`[Weather] Received TAFs for ${tafs.size} airports`);
    
    const tafRows: WeatherRow[] = [];
    for (const [, forecasts] of tafs) {
      tafRows.push(...forecasts);
    }
    
    tafCount = await batchInsertWeather(tafRows);
    console.log(`[Weather] Inserted ${tafCount} TAF forecast hours`);
  } catch (err) {
    console.error('[Weather] TAF fetch failed:', err);
    sendAlert('weather-service', 'warning', 'TAF fetch failed', err).catch(() => {});
    // TAF is optional — METAR data is what powers the UI
  }

  console.log(`[Weather] Done. Total: ${metarCount} METAR + ${tafCount} TAF records`);
}

/**
 * Fetch weather for flights departing or arriving in the next 20 minutes.
 * This ensures weather is fresh ~15 minutes before the flight time.
 */
export async function fetchWeatherForUpcomingFlights(): Promise<void> {
  const now = new Date();
  const twentyMinutesFromNow = new Date(now.getTime() + 20 * 60 * 1000);
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);

  // Find flights departing or arriving in the next 20 minutes
  const upcomingFlights = await db
    .select({
      departureAirport: flights.departureAirport,
      arrivalAirport: flights.arrivalAirport,
      scheduledDeparture: flights.scheduledDeparture,
      scheduledArrival: flights.scheduledArrival,
      actualDeparture: flights.actualDeparture,
      actualArrival: flights.actualArrival,
      flightNumber: flights.flightNumber,
      status: flights.status,
    })
    .from(flights)
    .where(
      sql`(
        -- Departing in the next 20 minutes (use actual/estimated if available, otherwise scheduled)
        (${flights.actualDeparture} IS NOT NULL AND ${flights.actualDeparture} >= ${now} AND ${flights.actualDeparture} <= ${twentyMinutesFromNow})
        OR 
        (${flights.actualDeparture} IS NULL AND ${flights.scheduledDeparture} >= ${now} AND ${flights.scheduledDeparture} <= ${twentyMinutesFromNow})
        OR
        -- Arriving in the next 20 minutes (use actual/estimated if available, otherwise scheduled)
        (${flights.actualArrival} IS NOT NULL AND ${flights.actualArrival} >= ${now} AND ${flights.actualArrival} <= ${twentyMinutesFromNow})
        OR
        (${flights.actualArrival} IS NULL AND ${flights.scheduledArrival} >= ${now} AND ${flights.scheduledArrival} <= ${twentyMinutesFromNow})
        OR
        -- Recently departed (within last 15 min) - refresh arrival airport weather
        (${flights.actualDeparture} IS NOT NULL AND ${flights.actualDeparture} >= ${fifteenMinutesAgo} AND ${flights.actualDeparture} <= ${now})
        OR
        (${flights.actualDeparture} IS NULL AND ${flights.scheduledDeparture} >= ${fifteenMinutesAgo} AND ${flights.scheduledDeparture} <= ${now})
      )`
    );

  if (upcomingFlights.length === 0) {
    return;
  }

  // Collect unique airport codes
  const airportCodes = new Set<string>();
  for (const flight of upcomingFlights) {
    airportCodes.add(flight.departureAirport);
    airportCodes.add(flight.arrivalAirport);
  }

  const icaoMapping = await getIcaoMapping(Array.from(airportCodes));
  
  const airportsList: { code: string; icao: string }[] = [];
  for (const code of airportCodes) {
    const icao = icaoMapping.get(code);
    if (icao) {
      airportsList.push({ code, icao });
    }
  }

  if (airportsList.length === 0) {
    return;
  }

  console.log(`[Weather] Upcoming flights check: refreshing ${airportsList.length} airports for ${upcomingFlights.length} flights: ${airportsList.map(a => a.code).join(', ')}`);

  try {
    // Fetch METARs for just these airports
    const metars = await fetchAllMetars(airportsList);
    
    const metarRows: WeatherRow[] = [];
    for (const airport of airportsList) {
      const data = metars.get(airport.icao);
      if (!data || data.temp == null) continue;
      
      const cloudCover = getCloudCoverPercent(data);
      metarRows.push({
        airportCode: airport.code,
        timestamp: now,
        temperature: data.temp,
        windSpeed: data.wspd ?? null,
        windDirection: data.wdir ?? null,
        visibility: data.visib ?? null,
        cloudCover,
        pressure: data.pressure ?? null,
        weatherCode: getWeatherCode(cloudCover),
      });
    }
    
    if (metarRows.length > 0) {
      const metarCount = await batchInsertWeather(metarRows);
      console.log(`[Weather] Upcoming flights: refreshed ${metarCount} METAR records`);
    }
  } catch (err) {
    console.error('[Weather] Error fetching weather for upcoming flights:', err);
  }
}


