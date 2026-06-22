---
Phase: 2
Sequence: 0
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: NONE
Confidence: high
Anchor: apps/web/src/routes/flights/[id]/+page.server.ts
Anchor-Sha8: 16c9d7fd
---

## Summary

The anchor file is a SvelteKit `+page.server.ts` load function for the flight detail page. All database queries use Drizzle ORM with parameterized binding — no raw SQL, no file operations, no command execution, no deserialization of untrusted data. The `params.id` is parsed as a base-10 integer and validated with `isNaN()`. No authentication is required, but this is by design: the flights table contains public flight-tracking data with no ownership or privacy model. All data originates from trusted scraper services (airport.gg API, FlightRadar24.com) — no user-submitted content flows into the flights table. No exploitable vulnerability found after tracing the full data flow through the anchor, companion `+page.svelte`, sub-components, database schema, and scraper sources.

### Defense-in-depth note

The companion `+page.svelte` uses `{@html}` with `JSON.stringify()` to inject a JSON-LD breadcrumb `<script>` tag in `<svelte:head>` containing `flight.flightNumber` (`apps/web/src/routes/flights/[id]/+page.svelte:233`). `JSON.stringify` does not escape `</` sequences, so if `flightNumber` contained `</script><script>alert(1)</script>` it would break out of the script context and execute arbitrary JS. In practice, `flights.flightNumber` is `varchar(20)`, populated by scrapers that extract airline-standard codes (e.g. "GR601", "BA2775") from trusted external APIs, and the FR24 scraper additionally runs `cleanFlightNumber()` which strips whitespace and uppercases. No user-controlled input reaches this field. This is a defense-in-depth weakness rather than an exploitable vulnerability under the current threat model.
