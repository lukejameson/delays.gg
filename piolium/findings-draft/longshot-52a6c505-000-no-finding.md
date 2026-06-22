---
Phase: 2
Sequence: 000
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: NONE
Confidence: high
Anchor: apps/guernsey-scraper/src/index.ts
Anchor-Sha8: 52a6c505
---

## Summary

After rigorous review of the anchor file (`apps/guernsey-scraper/src/index.ts`) and all transitive dependencies (`scraper.ts`, `live.ts`, `@airways/common`, `@airways/database`, `@airways/telegram`), no exploitable vulnerabilities were found. The codebase is a well-structured TypeScript scraper that uses Drizzle ORM for parameterized database operations, native `fetch` for outbound HTTP, cheerio for HTML parsing, and environment variables for all secrets. All database queries are parameterized; there are no `exec`/`spawn`/`eval` calls; file system access is limited to `.env` loading; and all user-controllable input paths (environment variables) are under operator control rather than attacker control. The theoretical SSRF vector through `GUERNSEY_API_URL`/`GUERNSEY_AIRPORT_URL` env vars is not exploitable by an unauthenticated remote attacker, as these are deployment-time configuration values. The singleton advisory lock "fail open" behavior on database errors is an intentional design choice documented in the code.
