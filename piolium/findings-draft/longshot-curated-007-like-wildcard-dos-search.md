---
Phase: 3
Sequence: 007
Slug: like-wildcard-dos-search
Verdict: VALID
Severity-Original: MEDIUM
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-a1466616-001-like-wildcard-dos.md
  - piolium/findings-draft/longshot-a2504b7b-001-like-wildcard-injection.md
---

## Summary

The search functionality — both the public `/search` page and the authenticated `/api/debug/ui/search` debug endpoint — interpolates the user-supplied `q` parameter directly into PostgreSQL `ILIKE` patterns (`%${query}%`) without escaping LIKE wildcards (`%`, `_`), without imposing input length limits, and with no rate limiting. The leading `%` in every pattern prevents PostgreSQL from using B-tree indexes, guaranteeing full sequential table scans on the `flights` table. An attacker can craft expensive search patterns that force database resource exhaustion and denial of service.

## Affected Files

- `apps/web/src/routes/search/+page.server.ts:17-22` — public search: 4× `ILIKE` with raw user input
- `apps/web/src/routes/api/debug/ui/search/+server.ts:27-32` — debug search: identical pattern (behind auth)
- `packages/database/schema.ts:65-69` — B-tree indexes on flightNumber, departureAirport, arrivalAirport — unusable with leading `%`

## Root Cause

User input is interpolated directly into `ILIKE` pattern strings without:
1. Escaping LIKE metacharacters (`%` and `_` treated as wildcards by PostgreSQL)
2. Length limits on the query string
3. Rate limiting to prevent request flooding
4. Trigram indexes (`pg_trgm` GIN) to support leading-wildcard queries

## Attacker Control

The attacker controls the `q` URL query parameter on GET requests to `/search` (unauthenticated) or `/api/debug/ui/search` (requires debug token). The value flows into Drizzle's `ilike()` as `%${query}%` with no sanitization.

## Impact

- **Denial of Service**: Attacker sends high volumes of requests with crafted patterns (e.g., `q=%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%`)
- **Full sequential scans**: The leading `%` prevents B-tree index usage on all 4 searched columns
- **No rate limiting**: Confirmed via grep — zero rate-limit/throttle mechanisms in `apps/web/src/`
- **No input length limit**: Arbitrarily long query strings consume application memory and database CPU
- Both public and debug search endpoints share the same vulnerable pattern

## Evidence

**Public search — raw ILIKE interpolation** (`apps/web/src/routes/search/+page.server.ts:17-22`):
```typescript
ilike(flights.flightNumber, `%${query}%`),
ilike(flights.airlineCode, `%${query}%`),
ilike(flights.departureAirport, `%${query}%`),
ilike(flights.arrivalAirport, `%${query}%`),
```

**Debug search — identical pattern** (`apps/web/src/routes/api/debug/ui/search/+server.ts:27-32`):
```typescript
ilike(flights.flightNumber, `%${query}%`),
ilike(flights.airlineCode, `%${query}%`),
ilike(flights.departureAirport, `%${query}%`),
ilike(flights.arrivalAirport, `%${query}%`),
```

**Drizzle ilike generates parameterized `column ILIKE $1`** — PostgreSQL treats `%` and `_` in bind parameters as wildcards.

**No rate limiting** — `grep -r 'rate.?limit|ratelimit|throttle' apps/web/src/` returns zero matches.

**B-tree indexes only** (`packages/database/schema.ts:65-69`):
```typescript
index('flights_flight_number_idx').on(table.flightNumber),
index('flights_departure_airport_idx').on(table.departureAirport),
index('flights_arrival_airport_idx').on(table.arrivalAirport),
```
No `pg_trgm` GIN indexes to support leading-wildcard ILIKE.

## Exploit Sketch

1. Attacker sends repeated GET requests to `/search?q=%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%` (or even a simple `?q=A` — leading `%` alone triggers full scan)
2. PostgreSQL performs full sequential scan of `flights` table for each request
3. No rate limiting means hundreds of requests/second are possible
4. Database CPU saturates, legitimate requests time out

## Confidence Notes

HIGH confidence — the code pattern is directly visible in two separate files (public and debug search). The absence of rate limiting and input length validation is confirmed through grep. The attack requires no authentication for the public endpoint. Severity depends on `flights` table size (unknown) — larger tables amplify impact.
