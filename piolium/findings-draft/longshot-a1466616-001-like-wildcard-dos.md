---
id: longshot-a1466616-001
phase: X2
anchor: apps/web/src/routes/search/+page.server.ts
slug: like-wildcard-dos
severity: medium
confidence: high
---

## Summary

The search endpoint at `/search` interpolates the user-supplied `q` parameter directly into PostgreSQL `ILIKE` patterns (`%${query}%`) without sanitizing LIKE wildcards (`%`, `_`), without imposing any input length limit, and with no rate limiting. An attacker can craft expensive search patterns that force full-table scans on the `flights` table, enabling database resource exhaustion and denial of service.

## Location

- `apps/web/src/routes/search/+page.server.ts:17-22` — primary sink: `ilike()` calls with raw user input
- `apps/web/src/routes/search/+page.server.ts:5` — entry point: `q` parameter read from URL
- `apps/web/src/routes/search/+page.server.ts:36-40` — query execution with `db.select()`
- `apps/web/src/routes/api/debug/ui/search/+server.ts:28-33` — identical pattern in debug API mirror (behind auth, but same code)

## Attacker Control

The attacker controls the `q` URL query parameter. This value is read at `+page.server.ts:5`:

```typescript
const query = url.searchParams.get('q')?.trim() ?? '';
```

No length validation, no character allowlist, no rate limiting is applied. The value flows directly into four `ILIKE` patterns (lines 17-22):

```typescript
conditions.push(
  or(
    ilike(flights.flightNumber, `%${query}%`),
    ilike(flights.airlineCode, `%${query}%`),
    ilike(flights.departureAirport, `%${query}%`),
    ilike(flights.arrivalAirport, `%${query}%`),
  )!,
);
```

## Trust Boundary Crossed

User-controlled HTTP query parameter → PostgreSQL query execution. While Drizzle ORM parameterizes the value (preventing SQL injection), PostgreSQL treats the `%` and `_` characters within the bound parameter as LIKE pattern wildcards, not as literals. The leading `%` also prevents PostgreSQL from using B-tree indexes on the searched columns (`flights_flight_number_idx`, `flights_departure_airport_idx`, `flights_arrival_airport_idx`), forcing sequential scans.

## Impact

An attacker can:
1. Craft queries with numerous `%` wildcards to force expensive pattern matching across all rows
2. Exploit the leading-wildcard pattern (`%query%`) which prevents index usage, guaranteeing a full sequential scan on every request
3. Send high volumes of unauthenticated requests (no rate limiting exists anywhere in the application — confirmed by grep for `rate.?limit|ratelimit|throttle` returning zero results in the `apps/web/src` directory)
4. Send arbitrarily long query strings (no `maxlength` validation), consuming application memory and database CPU

At sufficient request volume, this degrades or denies service for legitimate users. The `flights` table is the core of the application — every page depends on it.

## Evidence

**Entry point** (`apps/web/src/routes/search/+page.server.ts:5`):
```typescript
const query = url.searchParams.get('q')?.trim() ?? '';
```

**Sink** (`apps/web/src/routes/search/+page.server.ts:17-22`):
```typescript
ilike(flights.flightNumber, `%${query}%`),
ilike(flights.airlineCode, `%${query}%`),
ilike(flights.departureAirport, `%${query}%`),
ilike(flights.arrivalAirport, `%${query}%`),
```

**Drizzle `ilike` generates parameterized `column ILIKE $1`** (`node_modules/drizzle-orm/sql/expressions/conditions.js:121`):
```javascript
function ilike(column, value) {
  return sql`${column} ilike ${value}`;
}
```

The value is bound as a PostgreSQL parameter (confirmed in `node_modules/drizzle-orm/sql/sql.js:145-150` where plain values are wrapped in `Param` and escaped via `escapeParam`). This prevents SQL injection but does NOT escape LIKE wildcards — PostgreSQL treats `%` and `_` in bound parameters as pattern metacharacters.

**No rate limiting** — confirmed via:
```
grep -r 'rate.?limit|ratelimit|throttle' apps/web/src/ → no matches
```

**No input length limit** — the `q` parameter has no `maxlength` or server-side length check.

**Table indexes exist but are unusable with leading `%`** (`packages/database/schema.ts:65-69`):
```typescript
index('flights_flight_number_idx').on(table.flightNumber),
index('flights_departure_airport_idx').on(table.departureAirport),
index('flights_arrival_airport_idx').on(table.arrivalAirport),
```

## Exploit Sketch

1. An attacker sends repeated GET requests to `/search?q=%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%` (or any long string with many wildcards)
2. PostgreSQL performs a full sequential scan of the `flights` table for each request, matching the complex LIKE pattern against every row
3. With no rate limiting, the attacker can send hundreds of requests per second
4. Database CPU saturates, legitimate requests time out
5. The same attack works against `/search?q=` with any non-empty string, since the leading `%` already prevents index usage — even a simple query like `?q=A` triggers a full scan

## Open Questions

- Database size (number of rows in `flights`) unknown — larger tables amplify the impact
- PostgreSQL `ILIKE` performance characteristics with complex patterns may vary by version and configuration
- Whether a reverse proxy or CDN (e.g., Cloudflare) provides rate limiting at the network edge was not verified — the application itself has none
