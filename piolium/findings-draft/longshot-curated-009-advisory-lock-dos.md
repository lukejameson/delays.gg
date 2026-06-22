---
Phase: 3
Sequence: 009
Slug: advisory-lock-dos-via-debug-sql
Verdict: VALID
Severity-Original: MEDIUM
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-c5d9db3e-001-advisory-lock-dos-via-debug-sql.md
---

## Summary

The debug SQL endpoint allows an authenticated attacker to execute `SELECT pg_try_advisory_lock(hashtext('guernsey_live'))` and `SELECT pg_try_advisory_lock(hashtext('fr24_live'))` — functions that pass the keyword-based validation but acquire the same PostgreSQL advisory locks that the scraper services use for singleton enforcement. The locks persist on the pooled database connection after the query returns and block scraper processes from starting. Repeated requests can sustain this denial-of-service indefinitely.

## Affected Files

- `packages/database/singleton.ts:18-28` — `tryAcquireServiceLock()` uses `pg_try_advisory_lock(hashtext(serviceName))`
- `packages/database/index.ts:71-74` — shared connection pool with 30s idle timeout
- `apps/web/src/routes/api/debug/sql/+server.ts:36` — `sql.raw(query)` execution sink
- `apps/web/src/lib/server/debug-helpers.ts:84-102` — `validateSqlQuery()` allows advisory lock functions
- `apps/guernsey-scraper/src/live.ts:367-370` — Guernsey scraper calls `tryAcquireServiceLock('guernsey_live')`
- `apps/fr24-scraper/src/index.ts:279-282` — FR24 scraper calls `tryAcquireServiceLock('fr24_live')`

## Root Cause

`validateSqlQuery()` only blocks mutation keywords (`INSERT`, `UPDATE`, `DELETE`, etc.) but does not block PostgreSQL advisory-lock functions. The web server and all scraper processes connect to the same PostgreSQL database, so advisory locks are shared across all sessions. Session-level advisory locks persist until the connection is closed, surviving beyond query execution on the pooled connection.

## Attacker Control

An attacker with the `DEBUG_API_TOKEN` sends:
```
POST /api/debug/sql
{"sql": "SELECT pg_try_advisory_lock(hashtext('guernsey_live'))"}
```

## Impact

- **Guernsey scraper denial**: Lock acquisition causes scraper to `process.exit(0)` at `apps/guernsey-scraper/src/live.ts:369`
- **FR24 scraper denial**: Same attack with `hashtext('fr24_live')`
- **Sustained DoS**: Re-send request every ~25 seconds (before 30s idle timeout releases the connection)
- **Both scrapers can be blocked simultaneously** from a single pooled connection

## Evidence

**Singleton lock acquisition** (`packages/database/singleton.ts:18-28`):
```typescript
const result = await db.execute(
  sql`SELECT pg_try_advisory_lock(hashtext(${serviceName})) as locked`,
);
```

**Scraper exits on lock failure** (`apps/guernsey-scraper/src/live.ts:367-370`):
```typescript
const acquired = await tryAcquireServiceLock('guernsey_live');
if (!acquired) {
    console.log('[Guernsey Live] Another instance is already running (lock held). Exiting.');
    process.exit(0);
}
```

**Shared connection pool** (`packages/database/index.ts:71-74`):
```typescript
const pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
});
```

**Advisory locks not blocked** — `pg_try_advisory_lock` and `hashtext` do not appear in `DANGEROUS_KEYWORDS`.

## Exploit Sketch

1. Acquire `DEBUG_API_TOKEN` (via git leak curated finding 001 or auth bypass curated finding 002)
2. Send `POST /api/debug/sql` with `{"sql": "SELECT pg_try_advisory_lock(hashtext('guernsey_live'))"}`
3. Lock is acquired on the pooled connection; Guernsey scraper cannot start
4. Re-send every ~25 seconds to maintain the lock before idle timeout
5. Repeat for `hashtext('fr24_live')` to block both scrapers

## Confidence Notes

HIGH confidence — the advisory lock mechanism and the debug SQL bypass are both directly visible in source code. The shared database connection pool is confirmed. The only prerequisite is the `DEBUG_API_TOKEN`, which is exposed via curated finding 001 and bypassable via curated finding 002.
