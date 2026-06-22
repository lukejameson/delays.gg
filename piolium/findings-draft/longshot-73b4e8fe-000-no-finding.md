---
Phase: 2
Sequence: 000
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: NONE
Confidence: high
Anchor: apps/fr24-scraper/src/index.ts
Anchor-Sha8: 73b4e8fe
---

## Summary

The anchor file `apps/fr24-scraper/src/index.ts` is a scheduler/orchestrator for the FR24 flight scraper service. It loads configuration from environment variables, acquires a PostgreSQL advisory lock to prevent duplicate instances, then enters a loop of scraping (via `scrapeOnce()`), propagating aircraft registrations, and scheduling the next scrape cycle. All data flows through Drizzle ORM with parameterized queries. No attacker-controlled input reaches any sensitive sink. The `execSync` calls live in `scraper.ts` (not the anchor) and use fully hardcoded command strings. All `sendAlert()` calls in the anchor use hardcoded `message` strings. No command injection, SQLi, SSRF, path traversal, auth bypass, or deserialization vulnerabilities were found in or reachable through this file.

**Evidence coverage**: Read the anchor file in full (`apps/fr24-scraper/src/index.ts`, 290 lines), plus all direct imports: `scraper.ts` (1018 lines), `packages/telegram/src/index.ts` (32 lines), `packages/common/src/env.ts` (46 lines), `packages/common/src/circuit-breaker.ts` (140 lines), `packages/common/src/flights.ts` (57 lines), `packages/common/src/timezone.ts` (76 lines), `packages/common/src/config.ts` (97 lines), `packages/database/scheduler.ts` (271 lines), `packages/database/schema.ts` (194 lines), `packages/database/singleton.ts` (32 lines), `packages/database/index.ts` (96 lines). No untrusted input reaches any sensitive sink along any traced path.
