---
Phase: 2
Sequence: 000
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: NONE
Confidence: high
Anchor: apps/guernsey-scraper/src/live.ts
Anchor-Sha8: 59d1bc4b
---

## Summary

`apps/guernsey-scraper/src/live.ts` is a background scheduling orchestrator for the Guernsey airport flight scraper. It has no web-facing endpoints, accepts no user input, performs no command execution, and uses Drizzle ORM (parameterized) for all database operations. The file orchestrates scrape cycles, sleep/wake scheduling, timezone health checks, and wall-clock prefetch slots — all driven by environment variable configuration, system time, and database state. After tracing every data flow end-to-end through the scraper (`./scraper.ts`), the Telegram alert module (`@airways/telegram`), the circuit breaker (`@airways/common`), and the database scheduler helpers (`@airways/database/scheduler.ts`), no attacker-controllable input reaches any sensitive sink. The entry point `runLiveMode()` is invoked only via CLI (`apps/guernsey-scraper/src/index.ts`) when `SCRAPER_MODE=live`, never from a web route.

**Reviewed chain:**
- `live.ts` → `scrapeDayFlights()` from `./scraper` → `fetch()` to `airport.gg` (external API/HTML) → Drizzle ORM insert/update
- `live.ts` → `sendAlert()` from `@airways/telegram` (Telegram Bot API; all `message` params are hardcoded strings or system-time-derived)
- `live.ts` → `logSchedulerEvent()` → Drizzle ORM insert into `scraper_logs` (all `detail` params are hardcoded or DB-derived)
- `live.ts` → `tryAcquireServiceLock('guernsey_live')` → `pg_try_advisory_lock` (service name is hardcoded)
- Error handling: caught exceptions flow to `sendAlert` (error wrapped in backtick code block → safely escaped in Telegram Markdown) and `scraperLogs.errorMessage` (Drizzle ORM → parameterized)
