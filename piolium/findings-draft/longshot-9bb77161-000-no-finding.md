---
Phase: 2
Sequence: 000
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: INFO
Confidence: high
Anchor: apps/web/src/routes/api/debug/ui/flight/[id]/+server.ts
Anchor-Sha8: 9bb77161
---

## Summary

After rigorous review of the anchor file (`+server.ts`) and its supporting infrastructure (`debug-helpers.ts`, `hooks.server.ts`, `db.ts`, `schema.ts`), no exploitable vulnerability was found in this specific route handler. The only user-controlled input is `params.id` which is parsed as `parseInt(params.id, 10)` and used exclusively in Drizzle parameterized queries (`eq(flights.id, id)`, `eq(flightStatusHistory.flightId, id)`, etc.). All subsequent data flows use database-derived values (flight timestamps, airport codes, aircraft registration) as query parameters in Drizzle's query builder — no attacker-controlled strings reach any SQL sink. The endpoint exposes only flight, weather, position, daylight, and status history data — no PII, credentials, session tokens, or push subscription keys are queried. Auth is enforced by `hooks.server.ts:6-12` via Bearer token comparison against `DEBUG_API_TOKEN`.

Note: the shared `debug-helpers.ts` module's `validateSqlQuery()` function has known bypass vulnerabilities (comment-injection and PostgreSQL function bypass), but those affect the separate `/api/debug/sql` endpoint and are already documented by other piolium agents in findings `longshot-16201ecf-001` and `longshot-5a090d12-001`. This anchor file does not import or use `validateSqlQuery`.
