---
id: longshot-c1221f3d-000
phase: X2
anchor: packages/database/scheduler.ts
slug: no-finding
severity: none
confidence: high
---

## Summary

`packages/database/scheduler.ts` is a shared scheduling utility library for periodic flight-data scrapers. It provides: timer management (`clearAllTimers`), Drizzle ORM queries against the `flights`, `flightTimes`, and `scraperLogs` tables, a scheduler event logger, and logic for dynamic scrape-interval calculation, sleep/wake decisions, and wake-time computation.

After rigorous review of all functions, every import, all callers (`apps/guernsey-scraper/src/live.ts`, `apps/fr24-scraper/src/index.ts`), and the full data-flow graph (including the database connection layer `packages/database/index.ts`, the advisory-lock singleton `packages/database/singleton.ts`, the health monitor `apps/health-monitor/src/checks.ts`, the Telegram alert module `packages/telegram/src/index.ts`, and the circuit breaker `packages/common/src/circuit-breaker.ts`), **no exploitable vulnerability was found**.

**Key findings from review:**

- **SQL injection**: All database queries use Drizzle ORM's typed query builder (`eq`, `and`, `inArray`, `sql` template tag) with proper parameterization. No raw string concatenation into SQL. No `sql.raw()` anywhere in the codebase. The `serviceName as any` casts in `msSinceLastScrape:112` and `logSchedulerEvent:137` bypass TypeScript type checking but Drizzle still emits parameterized queries (`$1` placeholders), and PostgreSQL enforces the `scraper_service` enum at the DB level.
- **Command injection**: No `exec`, `spawn`, `child_process`, or shell calls in the anchor file. The guernsey-scraper caller does not use `execSync`; the fr24-scraper does but only in its own scraper module, not via scheduler functions.
- **SSRF / HTTP**: No outbound HTTP requests in the anchor file.
- **Deserialization / prototype pollution**: No deserialization of untrusted data.
- **Path traversal**: No file-system operations.
- **Authentication / authorization**: The scheduler is a library module with no HTTP handlers or auth checks — its callers are CLI scraper processes, not web-facing endpoints.
- **Hardcoded secrets / weak crypto**: `Math.random()` is used for scheduling jitter (`computeNextInterval:174,184,191,197,203`) — acceptable for non-cryptographic use. No hardcoded credentials.
- **Trust boundary violations**: All inputs to scheduler functions come from internal sources: database queries (flight data), environment variables (configuration), system clock (date strings), and computed reason strings. No user-controlled data reaches any function.

The file is a well-structured Drizzle ORM query utility with no attack surface for external adversaries.
