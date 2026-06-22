---
id: longshot-f92ae9a0-000
phase: X2
anchor: apps/position-service/src/index.ts
slug: no-finding
severity: informational
confidence: high
---

## Summary

After rigorous review of the anchor file (`apps/position-service/src/index.ts`), its sole dependency (`apps/position-service/src/poller.ts`), and all cross-package imports (`@airways/database`, `@airways/telegram`), no exploitable vulnerability was found. The position-service is a pure background worker with no HTTP server, no network listeners, and no user-facing entry points. All data flows through Drizzle ORM parameterized queries (no raw SQL injection vectors). External API calls to FlightRadar24 use `encodeURIComponent` on URL parameters with a hardcoded base URL (no SSRF). Status back-writes use only hardcoded string literals (`'Airborne'`, `'Taxiing'`, `'Landed'`). Environment variables are not hardcoded. The `sendAlert` Telegram helper does use `parse_mode: 'Markdown'` without escaping the `message` parameter, and one call site (`poller.ts:529`) passes database-sourced `airportCode` and `flight.flightNumber` into the message — but exploitation requires an attacker to control the upstream scraper source (airport.gg), and impact is limited to Telegram alert formatting confusion. This does not meet the bar for a reportable vulnerability given the extreme preconditions.
