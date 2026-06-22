---
id: longshot-5a090d12-001
phase: X2
anchor: apps/web/src/hooks.server.ts
slug: postgres-function-sql-validation-bypass
severity: high
confidence: high
---

## Summary

The debug SQL endpoint (`POST /api/debug/sql`) uses a validation function `validateSqlQuery` that checks the _first token_ of the SQL statement against an allowlist (SELECT, EXPLAIN, SHOW, DESCRIBE, WITH) and blocks a set of dangerous _keywords_ (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE). However, PostgreSQL's built-in meta-command functions — such as `pg_read_file()`, `pg_read_binary_file()`, `pg_ls_dir()`, `pg_sleep()`, `pg_terminate_backend()`, and `current_setting()` — are perfectly valid in a `SELECT` statement and contain none of the blocked keywords. A query like `SELECT pg_read_file('/etc/passwd')` passes validation and is executed directly against the database via `sql.raw()`, allowing an attacker who possesses the `DEBUG_API_TOKEN` to read arbitrary server files, enumerate directories, cause denial of service, and leak server configuration — all well beyond the intended "read-only database query" scope.

## Location

- `apps/web/src/hooks.server.ts:7-13` — auth gate that controls access to `/api/debug/*`
- `apps/web/src/lib/server/debug-helpers.ts:84-102` — `validateSqlQuery()` with insufficient blocklist
- `apps/web/src/routes/api/debug/sql/+server.ts:14-51` — raw SQL execution endpoint
- `apps/web/src/routes/api/debug/sql/+server.ts:36` — `sql.raw(query)` sink that injects raw user SQL

## Attacker Control

The attacker sends an HTTP `POST` to `/api/debug/sql` with:
- Header: `Authorization: Bearer <DEBUG_API_TOKEN>`
- Body: `{"sql": "SELECT pg_read_file('/etc/passwd')"}`

The `sql` field is extracted from the JSON body at `apps/web/src/routes/api/debug/sql/+server.ts:17-18`:
```typescript
const body = await request.json() as { sql?: string };
const query = body.sql?.trim();
```

The query string is validated by `validateSqlQuery()` and then passed to `sql.raw(query)` at line 36.

## Trust Boundary Crossed

The debug API is behind a Bearer-token gate (a shared secret). Once past that gate, the design intent is that the endpoint is limited to _read-only database queries_ (SELECT, EXPLAIN, SHOW, DESCRIBE, WITH). The `validateSqlQuery` function enforces this intent. However, the blocklist approach misses PostgreSQL meta-command functions that operate on the **server filesystem and runtime**, not just the database. This crosses the boundary from "read database rows" to "read server files / control server processes."

## Impact

An attacker with the debug API token can:

1. **Arbitrary file read**: `SELECT pg_read_file('/etc/passwd')` — reads any file the PostgreSQL process can access (subject to `pg_read_server_files` role in PG 14+).
2. **Directory enumeration**: `SELECT pg_ls_dir('/etc')` — lists server directory contents.
3. **Binary file exfiltration**: `SELECT encode(pg_read_binary_file('/app/secrets.key'), 'hex')` — reads binary files.
4. **Denial of service**: `SELECT pg_sleep(3600)` — blocks a database connection for an hour; repeated calls can exhaust the pool (max 5 connections per service).
5. **Connection termination**: `SELECT pg_terminate_backend(<pid>)` — kills other database connections.
6. **Configuration disclosure**: `SELECT current_setting('password_encryption')` — leaks server settings.

## Evidence

### 1. The auth gate in hooks.server.ts (lines 7-13)

```typescript
// apps/web/src/hooks.server.ts:7-13
if (event.url.pathname.startsWith('/api/debug/')) {
    const auth = event.request.headers.get('authorization');
    if (!validateDebugToken(auth, env.DEBUG_API_TOKEN)) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }
}
```

The auth check is correct — it prevents unauthenticated access. But once the token is known (shared secret model), all debug endpoints are accessible.

### 2. The SQL validation function (lines 84-102)

```typescript
// apps/web/src/lib/server/debug-helpers.ts:90-102
const ALLOWED_COMMANDS = new Set(['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'WITH']);
const DANGEROUS_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'];

export function validateSqlQuery(query: string): { valid: true } | { valid: false; error: string } {
  const firstToken = query.split(/\s+/)[0]?.toUpperCase() ?? '';
  if (!ALLOWED_COMMANDS.has(firstToken)) {
    return { valid: false, error: `Statement type "${firstToken}" not allowed. ...` };
  }
  const upperQuery = query.toUpperCase();
  for (const keyword of DANGEROUS_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(upperQuery)) {
      return { valid: false, error: `Dangerous keyword "${keyword}" detected ...` };
    }
  }
  return { valid: true };
}
```

`SELECT pg_read_file('/etc/passwd')`:
- First token: `SELECT` → in `ALLOWED_COMMANDS` ✓
- Uppercased: `SELECT PG_READ_FILE('/ETC/PASSWD')` — no DANGEROUS_KEYWORDS match ✓
- Result: `{ valid: true }` ✓ — **bypass confirmed**

### 3. The raw SQL execution sink (lines 33-42)

```typescript
// apps/web/src/routes/api/debug/sql/+server.ts:33-42
const d = getDb();
await d.execute(sql`SET SESSION statement_timeout = '30s'`);
let result;
try {
  result = await d.execute(sql`${sql.raw(query)}`);
} finally {
  await d.execute(sql`RESET statement_timeout`);
}
```

`sql.raw(query)` (`node_modules/drizzle-orm/sql/sql.d.ts:151`) injects the raw string directly into the SQL template. The `d.execute()` call sends it to the underlying `pg.Pool`, which executes it against PostgreSQL.

### 4. No mitigation in the test suite for pg_read_file

The comprehensive test file at `apps/web/src/lib/debug-comprehensive.test.ts` tests COPY, DO, SET, VACUUM, and REINDEX bypass attempts — but never tests PostgreSQL meta-command functions like `pg_read_file()`. A grep for `pg_read_file` across the entire repository returns zero results, confirming this attack vector was not considered.

## Exploit Sketch

1. Obtain the `DEBUG_API_TOKEN` (shared secret, e.g. from leaked `.env`, compromised CI, or insider).
2. Send a POST request:
   ```
   POST /api/debug/sql HTTP/1.1
   Authorization: Bearer ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1
   Content-Type: application/json

   {"sql": "SELECT pg_read_file('/etc/passwd')"}
   ```
3. The query passes `validateSqlQuery` (first token = SELECT, no dangerous keywords).
4. PostgreSQL executes `SELECT pg_read_file('/etc/passwd')` and returns the file contents in the response JSON `rows` array.
5. The attacker receives the file contents wrapped in the standard `debugResponse` envelope.

To enumerate the filesystem: `SELECT pg_ls_dir('/')` → lists root directory.

To DoS: `SELECT pg_sleep(300)` → blocks one connection for 5 minutes. Repeated calls (5 concurrent connections max per pool) can saturate the connection pool.

## Open Questions

1. **PostgreSQL privilege requirements**: In PostgreSQL 14+, `pg_read_file()` requires the `pg_read_server_files` role or superuser. If the database user lacks these privileges, the file-read attack is mitigated at the database level. However, `pg_sleep()`, `pg_terminate_backend()`, and `current_setting()` require no special privileges and remain exploitable.
2. **Multi-statement execution**: It was not verified whether `d.execute(sql.raw(query))` with the node-postgres driver supports multi-statement queries (e.g., `SELECT 1; SET statement_timeout = '0'`). If so, the attacker could reset the timeout and then execute long-running or resource-intensive queries. Even without multi-statement support, all the attacks enumerated above are single-statement.
3. **Additional unblocked dangerous operations**: The keyword blocklist may miss other PostgreSQL commands like `GRANT`, `REVOKE`, `COPY` (in specific contexts), `LISTEN`, `NOTIFY`, `UNLISTEN`, `DISCARD`, `REINDEX`, and `CLUSTER`. A comprehensive audit of PostgreSQL's SQL command set against the blocklist is recommended.
