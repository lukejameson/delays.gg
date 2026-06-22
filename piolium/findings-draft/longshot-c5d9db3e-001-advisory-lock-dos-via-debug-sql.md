---
Phase: 2
Sequence: 001
Slug: advisory-lock-dos-via-debug-sql
Verdict: VALID
Severity-Original: MEDIUM
Confidence: high
Anchor: packages/database/singleton.ts
Anchor-Sha8: c5d9db3e
---

## Summary

The `tryAcquireServiceLock()` function in `packages/database/singleton.ts` uses PostgreSQL advisory locks (`pg_try_advisory_lock + hashtext`) to enforce singleton execution of scraper services. The debug SQL endpoint (`POST /api/debug/sql`) allows an authenticated attacker (possessing `DEBUG_API_TOKEN`) to execute arbitrary SELECT queries via Drizzle's `sql.raw()` escape hatch. Because `pg_try_advisory_lock()` is a function that returns a value within a SELECT statement, it passes the endpoint's keyword blocklist validation. An attacker can acquire the same advisory locks that the scraper services depend on, permanently denying them the ability to start until the lock is released (when the pooled connection times out after 30 seconds idle, or the attacker explicitly releases it). Repeated polling can sustain this denial-of-service indefinitely.

## Location

- `packages/database/singleton.ts:18-28` — `tryAcquireServiceLock()` uses `pg_try_advisory_lock(hashtext(serviceName))` for singleton enforcement
- `packages/database/index.ts:75-82` — `db` Proxy shares the same lazy pool (`getDb()`) across all consumers in the web server process
- `apps/web/src/routes/api/debug/sql/+server.ts:36-40` — raw SQL execution via `sql.raw(query)` 
- `apps/web/src/lib/server/debug-helpers.ts:84-102` — `validateSqlQuery()` allows any SELECT statement (no block on advisory-lock functions)
- `apps/web/src/hooks.server.ts:7-13` — Bearer token auth gate for `/api/debug/*`
- `apps/guernsey-scraper/src/live.ts:367` — calls `tryAcquireServiceLock('guernsey_live')`
- `apps/fr24-scraper/src/index.ts:279` — calls `tryAcquireServiceLock('fr24_live')`

## Attacker Control

The attacker sends an HTTP POST to `/api/debug/sql` with:

```
Authorization: Bearer <DEBUG_API_TOKEN>
Content-Type: application/json

{"sql": "SELECT pg_try_advisory_lock(hashtext('guernsey_live'))"}
```

The `sql` field flows from `request.json()` → `body.sql.trim()` → `validateSqlQuery(query)` → `sql.raw(query)` → `db.execute()`. The `validateSqlQuery` function (`apps/web/src/lib/server/debug-helpers.ts:84-102`) only checks the first token against an allowlist (`SELECT`, `EXPLAIN`, `SHOW`, `DESCRIBE`, `WITH`) and blocks mutation keywords. `pg_try_advisory_lock` passes this validation: it's a valid SELECT expression, and neither `pg_try_advisory_lock` nor `hashtext` appear in the dangerous keywords list.

## Trust Boundary Crossed

The attacker crosses from the HTTP/debug-API boundary into the PostgreSQL advisory-lock namespace shared by all services connected to the same database. Advisory locks are global across all sessions on the same PostgreSQL database. A lock acquired by the web server's connection pool is visible to — and blocks — the scraper services' connection pools, even though they are separate Node.js processes.

## Impact

An attacker who possesses the `DEBUG_API_TOKEN` can:

1. **Deny service to the Guernsey scraper**: Acquire `pg_try_advisory_lock(hashtext('guernsey_live'))` via the debug SQL endpoint. The lock persists on the pooled connection after the query returns. When the guernsey-scraper process starts and calls `tryAcquireServiceLock('guernsey_live')` (`apps/guernsey-scraper/src/live.ts:367`), `pg_try_advisory_lock` returns `false` because the lock is held by the web server's pool connection. The scraper exits with `process.exit(0)` at `apps/guernsey-scraper/src/live.ts:369`.

2. **Deny service to the FR24 scraper**: Same attack with `hashtext('fr24_live')`.

3. **Sustain the DoS indefinitely**: The advisory lock is released when the pooled connection is destroyed (idle timeout of 30 seconds per `packages/database/index.ts:74` `idleTimeoutMillis: 30_000`). The attacker can re-send the request every ~25 seconds to maintain the lock.

## Evidence

### 1. Singleton lock acquisition (anchor file)

```typescript
// packages/database/singleton.ts:18-28
export async function tryAcquireServiceLock(serviceName: string): Promise<boolean> {
  try {
    const result = await db.execute(
      sql`SELECT pg_try_advisory_lock(hashtext(${serviceName})) as locked`,
    );
    const locked = (result.rows[0] as { locked: boolean } | undefined)?.locked ?? false;
    return locked;
  } catch (err) {
    console.error(`[singleton] Failed to acquire lock for '${serviceName}':`, err);
    return true;
  }
}
```

### 2. Both callers use hardcoded service names, sharing the advisory lock namespace

```typescript
// apps/guernsey-scraper/src/live.ts:367-370
const acquired = await tryAcquireServiceLock('guernsey_live');
if (!acquired) {
    console.log('[Guernsey Live] Another instance is already running (lock held). Exiting.');
    process.exit(0);
}
```

```typescript
// apps/fr24-scraper/src/index.ts:279-282
const acquired = await tryAcquireServiceLock('fr24_live');
if (!acquired) {
    console.log('[FR24] Another instance is already running (lock held). Exiting.');
    process.exit(0);
}
```

### 3. Debug SQL endpoint uses `sql.raw()` — raw SQL execution

```typescript
// apps/web/src/routes/api/debug/sql/+server.ts:36-40
let result;
try {
  result = await d.execute(sql`${sql.raw(query)}`);
} finally {
  await d.execute(sql`RESET statement_timeout`);
}
```

### 4. Validation allows `pg_try_advisory_lock` (no block on advisory-lock functions)

```typescript
// apps/web/src/lib/server/debug-helpers.ts:70-75
const ALLOWED_COMMANDS = new Set(['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'WITH']);
const DANGEROUS_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'];
```

`pg_try_advisory_lock` is not blocked. Neither is `hashtext`, `pg_advisory_lock`, `pg_advisory_unlock`, `pg_advisory_xact_lock`, or any other advisory-lock function.

### 5. Both web server and scrapers share the same database (advisory locks are global)

The web server's `getDb()` (`apps/web/src/lib/server/db.ts:3-4`) and the scrapers' `getDb()` (`packages/database/index.ts:67-74`) connect to the same PostgreSQL database. PostgreSQL advisory locks are scoped to the database, shared by all connected sessions regardless of which process they originate from.

### 6. Advisory locks persist on pooled connections

```typescript
// packages/database/index.ts:71-74
const pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});
```

Session-level advisory locks (`pg_try_advisory_lock`) persist until the session ends. The pool keeps connections alive; they are only destroyed after `idleTimeoutMillis` (30s) of inactivity. The lock therefore survives beyond the query execution.

## Exploit Sketch

1. Attacker obtains `DEBUG_API_TOKEN` (from env leak, git history, misconfiguration, or an existing auth bypass finding such as URL-encoding in `longshot-cad49483-001`).
2. Attacker sends:
   ```
   POST /api/debug/sql
   Authorization: Bearer <token>
   {"sql": "SELECT pg_try_advisory_lock(hashtext('guernsey_live'))"}
   ```
3. The query executes. PostgreSQL acquires the advisory lock on the borrowed connection. Returns `{"rows":[{"locked":true}],"count":1,...}`.
4. Connection returns to pool with lock held.
5. Guernsey scraper starts (or restarts), calls `tryAcquireServiceLock('guernsey_live')`. The underlying `pg_try_advisory_lock` returns `false` because the lock is held by the web server's pool connection.
6. Scraper exits with code 0.
7. To sustain the DoS, attacker re-sends the request every ~25 seconds (before the 30s idle timeout destroys the connection).

Variation: The attacker can call `pg_try_advisory_lock(hashtext('fr24_live'))` to block the FR24 scraper as well. Both can be blocked simultaneously by the same pooled connection since a single session can hold multiple advisory locks.

## Open Questions

- **Token requirement**: The attack requires the `DEBUG_API_TOKEN`. If this token is properly secured and not leaked, the attack surface is limited to insiders or secondary token-theft attacks. The `.env.example` file (`DEBUG_API_TOKEN=your-debug-api-token-change-me`) suggests a risk of default/weak tokens in deployment.
- **Connection pool isolation**: If the web server and scrapers used separate PostgreSQL databases or separate advisory-lock namespaces (two-argument form), this attack would not be possible.
- **`pg_advisory_unlock`**: An attacker could also use the debug endpoint to explicitly release locks via `SELECT pg_advisory_unlock(hashtext('guernsey_live'))`, enabling them to control exactly when the scraper can start — a more targeted attack.
