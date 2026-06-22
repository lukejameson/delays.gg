---
id: longshot-d87c4925-000
phase: X2
anchor: apps/adsb-service/src/index.ts
slug: no-finding
severity: none
confidence: high
---

## Summary

The anchor file (`apps/adsb-service/src/index.ts`) is a background polling service that queries free community ADS-B aggregators (adsb.lol, airplanes.live) for live aircraft data and updates flight records in PostgreSQL via Drizzle ORM. After tracing all data flows — from external API responses through matching logic into database writes and Telegram alerts — no exploitable vulnerability was found. All database operations use parameterized queries (Drizzle ORM); there is no command execution, file I/O with attacker-controlled paths, deserialization of untrusted data, or dynamic code evaluation. Race-condition guards exist at the database row level via WHERE clause conditions. Errors propagated to `sendAlert` originate from internal operations (PostgreSQL errors, network errors), not from attacker-controlled API data.
