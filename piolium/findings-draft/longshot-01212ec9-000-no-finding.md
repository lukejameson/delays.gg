---
id: longshot-01212ec9-000
phase: X2
anchor: apps/web/src/lib/time.ts
slug: no-finding
severity: none
confidence: high
---

## Summary

`apps/web/src/lib/time.ts` is a pure display-formatting utility with zero I/O, no database access, and no network operations. All five exported functions (`formatGuernseyTime`, `formatGuernseyDateTime`, `formatGuernseyShortDate`, `formatDate`, and the `GY_TZ` constant) are thin wrappers around `new Date()` + `toLocale*String`/`toLocale*DateString` browser APIs with a hardcoded `'Europe/London'` timezone. Every caller across the codebase (`+page.svelte`, `flights/[id]/+page.svelte`, `stats/+page.svelte`, `FlightCard.svelte`, `FlightTimeline.svelte`) passes only database-fetched timestamps or server-generated `Date` objects — no user-controlled strings, URL parameters, form data, or request bodies reach these formatters without first passing through typed Drizzle ORM queries on the server. Svelte auto-escapes all template output, so even malformed date strings (which would produce `"Invalid Date"`) carry no XSS risk. No trust boundary is crossed; no sensitive sink is reachable.
