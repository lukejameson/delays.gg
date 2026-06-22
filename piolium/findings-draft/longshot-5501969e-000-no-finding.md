---
Phase: 2
Sequence: 000
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: NONE
Confidence: high
Anchor: scripts/fix-actual-times.ts
Anchor-Sha8: 5501969e
---

## Summary

After thorough review, `scripts/fix-actual-times.ts` is a one-off CLI database maintenance script with no remotely exploitable vulnerabilities. The script has zero user-controlled input paths (all parameters are hardcoded or from environment variables), no web-facing route or API endpoint calls `fixActualTimes()`, and all database operations use Drizzle ORM with parameterized queries. The data processed (status messages from `airport.gg`, stored in `flight_status_history`) is parsed in memory with regex/string operations and results are written back as typed Date/integer values through Drizzle's parameterized update — no SQL injection, command injection, path traversal, or trust boundary violation is present.

Key locations reviewed:
- `scripts/fix-actual-times.ts` — anchor file, no user input, no I/O beyond DB
- `apps/guernsey-scraper/src/scraper.ts:962-1108` — `fixActualTimes()` implementation, all queries parameterized via Drizzle
- `apps/guernsey-scraper/src/index.ts:29-35` — only other caller, gated by `SCRAPER_MODE` env var
- `packages/database/index.ts` — `getDb()` / `db` proxy, connection via `DATABASE_URL` env var
- `packages/database/time.ts` — `localToUtc()` date construction, no injection surface
- No SvelteKit routes, API endpoints, or external-facing interfaces reference `fixActualTimes`
