---
Phase: 2
Sequence: 000
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: NONE
Confidence: high
Anchor: apps/guernsey-scraper/src/scraper.ts
Anchor-Sha8: db709f8d
---

## Summary

After thorough review of the Guernsey Airport scraper (`apps/guernsey-scraper/src/scraper.ts`) and its complete data flow — from external source fetch through parsing, database storage, and web UI rendering — no exploitable security vulnerabilities were found. The code fetches flight data from airport.gg (HTML pages and a JSON API), parses it with cheerio and standard JSON parsing, stores it via Drizzle ORM with parameterized queries, and the data is rendered in the SvelteKit web app using Svelte's auto-escaping template syntax. All trust boundaries are properly handled.

### Areas examined and cleared

- **Command injection**: No `exec`, `spawn`, `eval`, or `Function()` calls anywhere in the scraper or its dependency chain.
- **SQL injection**: All database queries use Drizzle ORM with column references and parameterized values. The few `sql` tagged template usages (e.g., `fixActualTimes` at `scraper.ts:1014-1061`) use Drizzle column references or hardcoded constants, never user-controlled strings.
- **Stored XSS**: Scraped `statusMessage` text (the primary untrusted string from airport.gg) is stored in `flightStatusHistory.statusMessage` (`text` column) and rendered in the web UI at `+page.svelte:393` as `{entry.statusMessage}`. Svelte 5 runes mode auto-HTML-escapes all `{expression}` interpolations. No `{@html}` in any template renders scraped data. The JSON-LD structured data at `+page.svelte:233` uses `JSON.stringify()` which safely escapes all special characters.
- **SSRF**: `fetchDayHtml` (`scraper.ts:109-127`) and `fetchApiData` (`scraper.ts:64-76`) construct URLs from environment variables (`GUERNSEY_AIRPORT_URL`, `GUERNSEY_API_URL`), not from user input. The date used in `fetchDayHtml` URL construction is derived from `Date` objects, not raw user input.
- **Path traversal**: No file system operations in the scraper.
- **Deserialization RCE**: Only `response.json()` and cheerio HTML parsing are used — both safe.
- **AuthZ bypass**: Not applicable — the scraper has no HTTP routes. Debug API endpoints in the web app are gated behind Bearer token authentication in `hooks.server.ts:10`.
- **Race conditions**: The live scraper uses PostgreSQL advisory locks via `tryAcquireServiceLock('guernsey_live')` in `live.ts:377`. Database upserts use `onConflictDoUpdate`/`returning()`.
- **Secrets**: API key is stored in env var `GUERNSEY_API_KEY` and never logged. The `fetchApiData` function logs `API_URL` without the key (`scraper.ts:66`).

### Minor observation (not a vulnerability)

The Guernsey API key is passed as a URL query parameter (`?key=${getApiKey()}` at `scraper.ts:65`) rather than in an HTTP header. This means the full URL including the secret could appear in proxy/load-balancer access logs. Recommendation: use an `Authorization` or `X-API-Key` header instead. This does not constitute an exploitable vulnerability because an attacker would need prior access to the logging infrastructure.
