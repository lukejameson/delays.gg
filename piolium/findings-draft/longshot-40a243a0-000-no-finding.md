---
Phase: 2
Verdict: NO-FINDING
Anchor: apps/web/src/lib/status.ts
Anchor-Sha8: 40a243a0
---

## Summary

`apps/web/src/lib/status.ts` is a pure utility module containing string-manipulation functions (`isFlightCompleted`, `extractDelayReason`, `shortenStatus`, `statusHasDetail`) that derive display labels and boolean flags from flight status strings. After exhaustive review of the anchor file, all callers (5 Svelte components, 2 page server load functions), both scraper pipelines (FR24 and Guernsey Airport) that populate the database, the database schema (`flights.status` is `varchar(50)`, `flightStatusHistory.statusMessage` is `text`), and the data flow from external sources through the ORM to rendered HTML, no exploitable vulnerability was found.

**ReDoS**: Three regex patterns are used (`/next\s+info(?:\s+at)?\s+([0-9]{1,2}:[0-9]{2})/i`, `/([0-9]{1,2}:[0-9]{2}(?:\s*[AP]M)?)/i`, `/due\s+weather/`). None exhibit nested quantifiers or ambiguous alternation that could cause catastrophic backtracking. Tested mentally with worst-case crafted inputs — only linear scan behavior.

**XSS**: All return values from these functions are rendered in Svelte templates via `{expression}` syntax (auto-escaped). No `{@html}` usage with status-derived strings. The one `{@html}` instance on the flight detail page uses `JSON.stringify()` on structured flight metadata, not status text.

**SQL Injection**: Not applicable — this module does not touch the database. All database queries in the call chain use Drizzle ORM parameterized queries.

**Prototype pollution / injection / path traversal / auth bypass**: Not applicable — the module performs only read-only string operations and numeric comparisons on Date objects.

**Data trust boundary**: Status strings originate from scraped airport data (FR24 API, Guernsey Airport JSON API) and are written by separate scraper services. The web app only reads from the database. No API endpoint in `apps/web` accepts flight status writes. The contact form (`apps/web/src/routes/contact/+page.server.ts`) posts to an external Formspree endpoint, not to local storage.

**Logic flaws**: Minor edge cases exist (e.g., `isFlightCompleted` for canceled flights waits 1 hour after scheduled departure; unknown status strings pass through `shortenStatus` unmodified) but none cross a trust boundary or grant an attacker any capability.

No finding to report.
