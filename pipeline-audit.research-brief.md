# Research Brief: Data Pipeline Hardening Audit

**Date:** 2026-06-15
**Status:** ready-for-planning
**Handoff target:** plan-first skill

## Goal

Identify and document every issue in the airways.gg data pipeline — from scraper
health through data quality to display/tooling — so the plan-first skill can
produce a prioritized, phased fix plan.

## Context

airways.gg ingests flight data from three sources:

1. **guernsey_live** — airports.gg HTML scraper (primary source for schedule,
   status, aircraft registrations). Runs on a dynamic interval (2–15 min),
   sleeps at night 23:00–05:00 GY local. Also pulls a JSON API (`/arr-dep/json`)
   for live status updates.

2. **fr24_live** — FlightRadar24 browser-based scraper via Puppeteer with
   Cloudflare evasion. Supplements aircraft registrations and estimated times.
   Runs same scheduling pattern as guernsey_live.

3. **position-service** — FR24 API consumer that polls live aircraft positions
   every 5 minutes and writes to `aircraft_positions`.

Supporting services: weather-service (Open-Meteo), notification-service (push),
adsb-service (ADS-B Exchange), health-monitor, ml-service (delay prediction).

The codebase is a monorepo: `apps/` for services, `packages/` for shared code
(`@airways/database`, `@airways/common`, `@airways/telegram`), `projects/api/`
for a REST API, and `apps/web/` for the SvelteKit frontend.

## Issues Found

### Issue 1: Duplicate guernsey_live Scraper Instances (Critical)

**Evidence:** `scraper_logs` shows two interleaved sequences of WAKE/SLEEP
events at 04:00 UTC on 2026-06-15. Two WAKE messages fire at 04:00:00.094 and
04:00:00.941 — millisecond-separated, separate process instances. Two SLEEP
sequences follow. Each writes independent scraper_logs rows.

**Root cause:** Likely a Docker restart race — the container was restarted while
an old instance was still shutting down, or two compose stacks (dev + prod?)
share the same `web` network and database.

**Impact:** Double the database writes, confusing log history, potential
race conditions on flight upserts.

### Issue 2: fr24_scraper Sporadic Failures (Critical)

**Evidence:** 3 `retry`-status scraper_logs for `fr24_live` today (09:34,
07:36, plus one from June 6). All show 0 records and no `completed_at`.
The scraper uses Puppeteer with `puppeteer-real-browser` to bypass Cloudflare —
this is inherently fragile. When Cloudflare updates its challenge, the scraper
breaks silently.

**Impact:** Missing aircraft registrations and estimated times during failure
windows. Live web app shows `?` for those fields until the scraper recovers.

### Issue 3: BA1344 Duplicate with Corrupt Airport Code (Critical)

**Evidence:** Two `BA1344` rows for 2026-06-15:
- `id=42593`: `departure_airport='LHR'`, `scheduled_departure=10:55` (from guernsey)
- `id=42574`: `departure_airport='LONDONHEA'`, `scheduled_departure=11:55` (from FR24)

The FR24 scraper's `extractFlightRows` parses the airport name from the
"From/To" column instead of extracting the IATA code. `"London Heathrow (LHR)"`
is truncated to `"LONDONHEA"` (varchar(10) limit on `departure_airport`).
Additionally, the scheduled time is wrong — FR24 picked up the arrival time as
scheduled departure.

**Impact:** Duplicate rows break `/api/debug/flights` pagination, confuse the
flight detail page, and corrupt statistics.

### Issue 4: 29 Inconsistent Diversion Statuses (High)

**Evidence:** The `status` column (varchar free-text) contains 29 distinct
diversion-related strings with no normalization:
- Casing: `"Diverted To EXETER"` vs `"Diverted to Exeter"` vs `"DIVERTED TO EXETER"`
- IATA vs full name: `"Diverted to EXT"` vs `"Diverted To EXETER"`
- Extra verbiage: `"Flight Diverted To EXT Next Info 15:00"`, `"Aircraft Diverted to LGW - Due To Fog"`
- Non-divert status anomalies: `"Landed 12:32"`, `"Landed 18:58"` (embedded time in status)

The `deriveStatus()` function in `guernsey-scraper/src/scraper.ts` returns raw
messages for diverted flights (line ~330: `return updates[i].statusMessage`),
intentionally preserving the full text. But this creates downstream filtering
and analytics problems.

### Issue 5: Missing Data for BRS/EXT/LCY Routes (High)

**Evidence:** 6 flights on 2026-06-15 with NULL status, 5 with NULL
`aircraft_registration`:
- GR642 (GCI→BRS), GR643 (BRS→GCI), GR728 (GCI→EXT), GR729 (EXT→GCI),
  GR644 (BRS→GCI) — all NULL
- GR400 (GCI→LCY), GR401 (LCY→GCI) — have registrations but NULL status
- GR644 (GCI→BRS) works — has status "Scheduled" — but its return leg doesn't

The airport.gg HTML scraper depends on airport names matching against
`locationToIata()` mappings. Routes through BRS and EXT may not be present
on the airport.gg board, or the location name doesn't parse to a known IATA code.

### Issue 6: 777 NULL Status Flights Historically (High)

**Evidence:** `SELECT count(*) FROM flights WHERE status IS NULL` returns 778.
These are flights that were inserted (likely by FR24 or a historical backfill)
but never had a status derived. The display layer renders NULL as `?`.

### Issue 7: Stale Duplicate Live Positions (High)

**Evidence:** `airways_positions` returns 2 aircraft, both G-ISLP:
- Position 1: 49.70, -2.69 at 11,150ft (timestamp 09:23)
- Position 2: 49.99, -3.17 at 17,975ft (timestamp 09:18 — older)

The `/api/debug/positions` endpoint has no deduplication — it returns all
non-ground positions from a time window. The position-service writes points
every ~5 min per aircraft, and old points appear alongside new ones.

The `airways_positions` tool also has a bug: it filters `on_ground = false` but
doesn't apply a recency cutoff or select only the latest position per aircraft.

### Issue 8: Delay Display Formatting Bug (Medium)

**Evidence:** The flights API shows `+-7m`, `+-13m`, `+-4m` for early
flights. The delay value is stored correctly as negative integers (e.g., `-7`),
but the display layer prepends `+` unconditionally, producing `+-7m`.

Likely in the `airways_flights` tool or the frontend rendering: something like
`${delay >= 0 ? '+' : ''}${delay}m` is applied without handling the sign already
being in the number.

### Issue 9: airways_weather Tool Queries Wrong Table (Medium)

**Evidence:** `airways_weather` fails with `relation "weather" does not exist`.
The actual table is `weather_data`. The web endpoint `/api/debug/weather`
correctly uses `weatherData` from Drizzle schema. The tool definition references
the wrong table name.

### Issue 10: Tomorrow's Flights Leak into Today's Results (Medium)

**Evidence:** The first 5 rows of `/api/debug/flights` (no date filter) are
June 16 flights (GR300, GR200, GR662, GR600, GR650). The endpoint orders by
`scheduled_departure DESC` with no `flight_date` filter, so tomorrow's
prefetched flights sort to the top.

### Issue 11: No Test Coverage for Scrapers (Medium)

Only `apps/guernsey-scraper/src/scraper.test.ts` exists among scraper services.
The FR24 scraper, position-service, weather-service, and live-mode scheduling
have zero test coverage. The status normalization logic (`deriveStatus()`) has
no tests despite being a frequent source of bugs.

## Alternatives Considered

### Option A: Fix Everything in Priority Order

Address all 11 issues, phased by severity. Start with the duplicate scraper
instance (operational fix), then data quality (status normalization,
deduplication), then tooling bugs. Write tests as fixes are made.

- **Pros:** Comprehensive, leaves nothing behind.
- **Cons:** Large scope — may take multiple sessions.
- **Best for:** When pipeline reliability is the top priority.

### Option B: Scraper Stability Sprint

Focus exclusively on issues 1 (duplicate instances), 2 (FR24 failures), and
5 (missing route data). Get the ingestion pipeline rock-solid, then tackle
data quality in a follow-up.

- **Pros:** Narrower scope, faster impact on live data quality.
- **Cons:** Leaves inconsistent statuses and display bugs unresolved.
- **Best for:** When FR24 failures are causing visible outages.

### Option C: Data Quality Pass

Normalize statuses (issue 4), deduplicate flights (issue 3), backfill NULL
statuses (issue 6), and fix display bugs (issues 8–10). Don't touch scraper
infrastructure.

- **Pros:** Immediate user-facing improvement — cleaner UI, better stats.
- **Cons:** Underlying scraper issues continue producing bad data.
- **Best for:** When the frontend/API experience is the priority.

## Recommendation

**Option A — fix everything in priority order.** The issues are tightly coupled:
duplicate scraper instances produce duplicate data, which then needs dedup
logic. Missing route data means NULL statuses, which need both scraper fixes
and a backfill. Fixing display bugs without fixing the data source just papers
over the problem.

Suggested phasing:

1. **Infrastructure:** Fix duplicate guernsey_live instances (Docker/deployment)
2. **Scraper reliability:** Add retry with backoff for FR24, add Cloudflare
   failure detection
3. **Data normalization:** Status values → enum or constrained vocabulary;
   airport IATA codes → validate against `airports` table
4. **Deduplication:** One-shot cleanup of BA1344 duplicate + prevention
5. **Route gaps:** Add missing BRS/EXT routes to `locationToIata()` or scrape
   from an additional source
6. **Display/tooling:** Fix delay display, weather tool, position dedup

## Key Findings

- The two scrapers share identical scheduling logic (copy-pasted between
  `guernsey-scraper/src/live.ts` and `fr24-scraper/src/index.ts`) — DRY refactor
  opportunity.
- `deriveStatus()` intentionally preserves raw diversion messages for
  transparency but lacks a parallel normalized field.
- FR24 scraper writes `aircraft_registration` but NOT `actual_departure` or
  `actual_arrival` — those are owned exclusively by the guernsey scraper.
- The `scraper_logs` table uses the `error_message` column to store scheduler
  event labels (`[SLEEP]`, `[WAKE]`, `[PREFETCH]`) — this overloads the column
  and makes it hard to query for actual errors.
- `aircraft_positions` has no retention policy — 890 rows in the last 2 hours,
  growing unbounded.
- The docker-compose uses `restart: always` on scrapers — if a scraper crashes,
  it restarts immediately, which can explain the concurrent instance problem.

## Open Questions

1. Is the duplicate guernsey_live instance caused by a specific deployment
   event (manual restart, CI/CD deploy overlapping)?
2. Should diversion statuses be a separate column (`diverted_to_airport`) rather
   than crammed into the `status` varchar?
3. Should `aircraft_positions` have a TTL/retention policy (e.g., delete rows
   older than 24 hours)?
4. Does the BRS/EXT missing data affect only today or is it a persistent gap?

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Status normalization breaks existing UI | Medium | Add new `normalized_status` column, migrate gradually |
| FR24 scraper completely blocked by Cloudflare | High | Evaluate FR24 API as alternative to browser scraping |
| Duplicate instance fix causes data loss | Medium | Deploy during sleep window (23:00–05:00 GY) |
| Dedup script deletes wrong rows | Medium | Dry-run with SELECT before DELETE |

## Implementation Hints

- The scheduling logic in `guernsey-scraper/src/live.ts` and
  `fr24-scraper/src/index.ts` should be extracted to `@airwaves/common` to
  eliminate the copy-paste duplication (~200 lines each).
- Status normalization can be done as a DB migration with a CASE statement
  rather than application-level logic.
- The `scraper_logs.error_message` column should be split: keep `error_message`
  for actual errors, add a new `event_label` column for scheduler events.
- `aircraft_positions` queries should use `DISTINCT ON (registration) ORDER BY
  registration, position_timestamp DESC` to deduplicate.

---

*Generated by research-assistant skill v1.0.0*
*To proceed, invoke the plan-first skill with this brief as context.*
