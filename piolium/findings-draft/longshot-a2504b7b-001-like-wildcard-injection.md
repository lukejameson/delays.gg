---
id: longshot-a2504b7b-001
phase: X2
anchor: apps/web/src/routes/api/debug/ui/search/+server.ts
slug: like-wildcard-injection-search
severity: low
confidence: high
---

## Summary

The `/api/debug/ui/search` endpoint interpolates the user-supplied `q` query parameter directly into Drizzle ORM `ilike()` pattern strings without escaping SQL LIKE wildcards (`%` and `_`). While Drizzle ORM parameterizes the pattern value (preventing SQL injection), PostgreSQL's `ILIKE` operator still interprets `%` and `_` characters within the parameter value as wildcards. An attacker with the debug API token can craft expensive wildcard patterns that force full sequential table scans, causing database CPU exhaustion (Denial of Service).

## Location

- `apps/web/src/routes/api/debug/ui/search/+server.ts:27-32` — WHERE the unsanitized `query` variable is concatenated into 4 `ilike()` pattern strings
- `apps/web/src/routes/api/debug/ui/search/+server.ts:14` — WHERE the `q` query parameter is read from the URL without sanitization
- `packages/database/schema.ts:44-69` — flights table schema (no trigram indexes to mitigate LIKE attacks)
- `apps/web/src/lib/server/debug-helpers.ts:98-103` — auth gate reference (attack requires valid Bearer token)

## Attacker Control

The attacker controls the `q` query parameter via an HTTP GET request:

```
GET /api/debug/ui/search?q=<PAYLOAD> HTTP/1.1
Authorization: Bearer <valid-debug-token>
```

The `q` value is trimmed but otherwise passed directly into LIKE pattern construction. There is no length limit and no escaping of `%` or `_` characters.

## Trust Boundary Crossed

The attacker crosses the external-to-internal trust boundary: an authenticated HTTP request parameter flows through the server-side handler into a database query operator that interprets wildcard metacharacters in the attacker's input.

## Impact

**Denial of Service (database CPU exhaustion):** An attacker can send requests with crafted wildcard patterns such as `%a%b%c%d%e%f%g%h%` that force PostgreSQL to perform expensive pattern matching across 4 columns (`flight_number`, `airline_code`, `departure_airport`, `arrival_airport`) combined with `OR`. Because there are no `pg_trgm` GIN indexes on these columns (only B-tree indexes that are useless for leading-wildcard LIKE), every such query triggers a full sequential table scan.

**Information enumeration (minor):** An attacker can use `%` and `_` wildcards to probe for flight number patterns (e.g., `GR___` to match 5-character flight numbers starting with "GR"). However, this provides no additional data beyond what other debug endpoints already expose.

## Evidence

**1. Unsanitized input (anchor:14):**
```typescript
const query = url.searchParams.get('q')?.trim() ?? '';
```

**2. Direct interpolation into ilike patterns (anchor:27-32):**
```typescript
if (query) {
  conditions.push(or(
    ilike(flights.flightNumber, `%${query}%`),
    ilike(flights.airlineCode, `%${query}%`),
    ilike(flights.departureAirport, `%${query}%`),
    ilike(flights.arrivalAirport, `%${query}%`),
  )!);
}
```

Each `ilike()` call passes a pattern string like `%<attacker-input>%` as a parameterized value. PostgreSQL treats `%` and `_` inside the parameter value as LIKE wildcards.

**3. No trigram indexes (packages/database/schema.ts:60-67):**
```typescript
index('flights_flight_number_idx').on(table.flightNumber),
index('flights_departure_airport_idx').on(table.departureAirport),
index('flights_arrival_airport_idx').on(table.arrivalAirport),
index('flights_airline_date_idx').on(table.airlineCode, table.flightDate),
```

All are standard B-tree indexes. None support leading-wildcard `ILIKE '%pattern%'` queries. Each such query requires a sequential scan.

**4. Same vulnerability in the public search page (apps/web/src/routes/search/+page.server.ts:20-27):**
```typescript
if (query) {
  conditions.push(
    or(
      ilike(flights.flightNumber, `%${query}%`),
      ilike(flights.airlineCode, `%${query}%`),
      ilike(flights.departureAirport, `%${query}%`),
      ilike(flights.arrivalAirport, `%${query}%`),
    )!,
  );
}
```

The identical pattern exists in the public-facing search page load function, which does not require authentication.

## Exploit Sketch

1. Obtain or guess the debug API Bearer token (the endpoint is gated behind `validateDebugToken` in `hooks.server.ts`)
2. Send repeated GET requests with crafted `q` values containing many wildcards:

```
GET /api/debug/ui/search?q=%%25a%25b%25c%25d%25e%25f%25g%25h%25&limit=1000
Authorization: Bearer <token>
```

3. Each request forces PostgreSQL to scan the entire flights table with expensive ILIKE pattern matching across 4 columns
4. Sufficient concurrent requests exhaust database CPU, degrading service for legitimate users

The same attack works without authentication against the public search page at `/search`.

## Open Questions

- **Token strength:** The `DEBUG_API_TOKEN` is set via environment variable (`env.DEBUG_API_TOKEN`). If it is weak or leaked, the debug endpoint becomes trivially exploitable. The token is not the focus of this finding — this is about the LIKE wildcard injection within the endpoint.
- **Database scale:** The severity of the DoS depends on the size of the `flights` table. With millions of rows, the impact becomes HIGH.
- **`pg_trgm` extension:** If the PostgreSQL `pg_trgm` extension is available, adding GIN indexes with `gin_trgm_ops` on the searchable columns would mitigate this issue.
