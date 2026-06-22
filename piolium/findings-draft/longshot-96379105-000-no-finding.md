---
id: longshot-96379105-000
phase: X2
anchor: apps/web/src/routes/api/debug/flights/+server.ts
slug: no-finding
severity: informational
confidence: high
---

## Summary

After rigorous review of the anchor file (`apps/web/src/routes/api/debug/flights/+server.ts`), the debug helpers (`apps/web/src/lib/server/debug-helpers.ts`), the auth hooks (`apps/web/src/hooks.server.ts`), the database schema (`packages/database/schema.ts`), and the neighboring debug endpoints, no exploitable vulnerability was found in or anchored on this file.

**Why clean:**

- **Auth**: All `/api/debug/*` routes are gated behind `Authorization: Bearer <DEBUG_API_TOKEN>` via `apps/web/src/hooks.server.ts:7-12`. The `validateDebugToken` function at `apps/web/src/lib/server/debug-helpers.ts:97-102` is fail-closed — it returns `false` when the token env var is unset or the header is missing/malformed.

- **SQL Injection**: All query conditions (`eq`, `gte`, `lte`, `ilike`, `and`) use Drizzle ORM's parameterized query builders. The `ilike(flights.flightNumber, `%${flightNumber}%`)` pattern at `apps/web/src/routes/api/debug/flights/+server.ts:44` wraps user input in wildcards but the entire value is sent as a bound parameter — no raw string concatenation into SQL.

- **Sort injection**: User-controlled `sort` parameter (line 62) is mapped through a `sortColumns` record (lines 69-78); unknown values fall back to `flights.scheduledDeparture` — no column injection possible.

- **Information disclosure**: `db.select().from(flights)` (lines 80-81) returns only flight operational columns (flight numbers, airports, times, status, registration). No joins to related tables, no PII (e.g., no push subscription endpoints, no user sessions).

- **Error handling**: The `catch` block at line 84 returns `debugError('Query failed', 500)` — the actual error is logged server-side via `console.error` (line 85) but not exposed to the client.

- **Pagination**: `parsePagination` in `apps/web/src/lib/server/debug-helpers.ts:42-55` caps `limit` at 1000 (default 100) and clamps negative/NaN `offset` to 0.

- **No path traversal bypass**: SvelteKit normalizes `event.url.pathname` before the `startsWith('/api/debug/')` check in hooks, and SvelteKit's file-based routing is case-sensitive — no casing or encoding bypass exists.

**Note on rate limiting**: Unlike the `/api/debug/sql` endpoint (which sets `statement_timeout = '30s'`), this endpoint does not set a query timeout. However, the 1000-row limit and PostgreSQL's connection pool prevent any practical DoS.

**Note on neighboring endpoints**: The `/api/debug/sql` endpoint has a known bypass (PostgreSQL meta-command functions like `pg_read_file()` — see `longshot-5a090d12-001`) and the `/api/debug/push-subs` endpoint exposes Web Push subscription data (`endpoint`, `keys.p256dh`, `keys.auth`). These are documented in findings for their respective anchors and are not specific to this file.
