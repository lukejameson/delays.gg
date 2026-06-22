---
id: longshot-191e36e0-000
phase: X2
anchor: apps/weather-service/src/index.ts
slug: no-finding
severity: none
confidence: high
---

## Summary
The weather service is a background worker that fetches METAR/TAF data from `aviationweather.gov` and airport data from a public CSV on GitHub, stores results in PostgreSQL via Drizzle ORM, and sends Telegram alerts on errors. After reviewing the anchor (`index.ts`), all dependencies (`fetcher.ts`, `airports.ts`, `@airways/telegram`, `@airways/common`, `@airways/database`), and the downstream UI consumers, no exploitable vulnerability was found: all external URLs are hardcoded (no SSRF), all database writes use parameterized queries (no SQLi), no `eval`/`exec`/`child_process`/file operations exist, and the UI renders ingested data via Svelte's auto-escaping (no stored XSS vector).
