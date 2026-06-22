---
Phase: 2
Sequence: 002
Slug: sql-raw-weak-keyword-validation
Verdict: VALID
Severity-Original: HIGH
Confidence: medium
Anchor: scripts/debug-weather-join.ts
Anchor-Sha8: d5d04db9
---

## Summary

The `/api/debug/sql` endpoint at `apps/web/src/routes/api/debug/sql/+server.ts` uses Drizzle ORM's `sql.raw()` escape hatch to execute user-supplied SQL queries against the production database. The `validateSqlQuery()` function in `apps/web/src/lib/server/debug-helpers.ts` attempts to restrict queries to read-only statements via a keyword-based blacklist, but this validation is structurally inadequate: (1) it cannot prevent data exfiltration of sensitive tables through SELECT, and (2) the keyword blacklist can potentially be bypassed using PostgreSQL `DO` blocks with string-concatenated keywords that evade word-boundary regex detection. The anchor file `scripts/debug-weather-join.ts` demonstrates the legitimate debug SQL pattern using Drizzle's `sql` tagged template; the debug endpoint subverts this pattern by passing untrusted input through `sql.raw()`.

## Location

- `apps/web/src/routes/api/debug/sql/+server.ts:38` — `sql.raw(query)` passes user input unsanitized to the database
- `apps/web/src/lib/server/debug-helpers.ts:68-100` — `validateSqlQuery()` keyword-based validation
- `apps/web/src/lib/server/debug-helpers.ts:72` — `ALLOWED_COMMANDS` set (SELECT, EXPLAIN, SHOW, DESCRIBE, WITH)
- `apps/web/src/lib/server/debug-helpers.ts:75` — `DANGEROUS_KEYWORDS` array (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE)
- `packages/database/schema.ts:22-43` — `users` and `sessions` tables with sensitive columns
- `scripts/debug-weather-join.ts:13,24,33` — anchor file using safe `sql` tagged template for debug queries

## Attacker Control

An authenticated attacker (possessing the `DEBUG_API_TOKEN`) sends a JSON POST body to `/api/debug/sql` with a `sql` field containing arbitrary SQL. The value flows through `request.json()` → `body.sql` → `.trim()` → `validateSqlQuery()` → `sql.raw(query)` → `db.execute()`. The `validateSqlQuery()` function is the only security barrier between attacker-controlled input and raw SQL execution.

## Trust Boundary Crossed

The trust boundary is between the HTTP request body (attacker-controlled) and the PostgreSQL database connection. The `sql.raw()` function in Drizzle ORM is explicitly designed as an escape hatch that bypasses all parameterization — it inserts the raw string directly into the SQL statement. The `validateSqlQuery()` function attempts to enforce a read-only boundary but uses a naive keyword-matching approach that cannot guarantee safety.

## Impact

**With SELECT-only access (no bypass needed):**
- Exfiltration of all `users` rows including `passwordHash` (bcrypt hashes crackable offline)
- Exfiltration of all `sessions` rows including `token` (session hijacking / account takeover)
- Reading of all operational data: flights, weather, push subscriptions, scraper logs, aircraft positions

**With potential keyword-bypass (DO block technique):**
- Destruction or modification of data via `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`DROP`
- Potential filesystem access via `lo_import()` or `pg_read_file()` if available
- Full database compromise

## Evidence

**`sql.raw()` bypasses parameterization** (`apps/web/src/routes/api/debug/sql/+server.ts:38`):
```typescript
result = await d.execute(sql`${sql.raw(query)}`);
```
The `sql.raw()` function from drizzle-orm inserts the string verbatim into the SQL without any escaping or parameterization. This is the documented escape hatch for raw SQL.

**Keyword validation is regex-based and naive** (`apps/web/src/lib/server/debug-helpers.ts:86-91`):
```typescript
const upperQuery = query.toUpperCase();
for (const keyword of DANGEROUS_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(upperQuery)) {
        return { valid: false, error: `Dangerous keyword "${keyword}" detected...` };
    }
}
```

**Potential DO-block bypass**: A query like:
```sql
SELECT 1; DO $$ BEGIN EXECUTE 'DEL' || 'ETE FROM flights'; END $$;
```
Would pass validation because:
1. First token is `SELECT` (allowed)
2. Uppercased: `SELECT 1; DO $$ BEGIN EXECUTE 'DEL' || 'ETE FROM FLIGHTS'; END $$;`
3. No dangerous keyword appears as a complete word (`DELETE` is split across `'DEL'` and `'ETE'`)
4. PostgreSQL executes the `DO` block, which dynamically concatenates and executes `DELETE FROM flights`

**Sensitive data accessible via SELECT** (`packages/database/schema.ts:22-31`):
```typescript
export const users = pgTable('users', {
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  ...
});
```

**DANGEROUS_KEYWORDS is incomplete** — missing keywords that can cause harm (`apps/web/src/lib/server/debug-helpers.ts:75`):
```typescript
const DANGEROUS_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'];
```
Missing: `GRANT`, `REVOKE`, `COPY` (though blocked by first-token check), `VACUUM`, `REINDEX`, `DISCARD`, `SET` (for session-level changes), `LISTEN`/`NOTIFY` (for event-based attacks), and `DO` (for anonymous code blocks).

## Exploit Sketch

1. Obtain the `DEBUG_API_TOKEN` (see finding 001)
2. Send a POST to `https://airways.gg/api/debug/sql`:
   ```json
   {"sql": "SELECT email, password_hash FROM users"}
   ```
3. Receive all user credentials in the JSON response
4. For destructive operations, attempt the DO-block bypass:
   ```json
   {"sql": "SELECT 1; DO $$ BEGIN EXECUTE 'DEL' || 'ETE FROM flights'; END $$;"}
   ```

## Open Questions

- Whether the PostgreSQL driver (node-postgres via drizzle-orm `execute()`) processes multiple semicolon-separated statements in a single `sql.raw()` call — this determines if the `DO` block bypass is practically exploitable
- Whether PostgreSQL extensions like `dblink`, `postgres_fdw`, or `pg_cron` are installed, which would expand the attack surface
- Whether the database user has `pg_read_file` / `lo_import` privileges for filesystem access
- Whether `SET SESSION statement_timeout = '30s'` (`+server.ts:35`) is sufficient to prevent long-running DoS queries
