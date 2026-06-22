---
Phase: 2
Sequence: 001
Slug: select-into-bypass
Verdict: VALID
Severity-Original: HIGH
Confidence: high
Anchor: packages/database/schema.ts
Anchor-Sha8: e8be093f
---

## Summary

The debug SQL endpoint at `/api/debug/sql` uses `sql.raw()` to execute user-supplied SQL queries. The `validateSqlQuery()` function attempts to restrict queries to read-only operations by blocking INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, and CREATE. However, PostgreSQL's `SELECT ... INTO ...` syntax creates a new table from query results — yet `INTO` is not in the blocked keyword list. An attacker with the debug API token can bypass the read-only restriction entirely, creating new tables, exfiltrating sensitive data into them, and reading them back. This turns a supposedly read-only debug endpoint into a full data-manipulation surface against every table defined in `packages/database/schema.ts`.

## Location

- `packages/database/schema.ts:1-202` — all tables (`users`, `sessions`, `flights`, `pushSubscriptions`, etc.) are exposed via this bypass
- `apps/web/src/lib/server/debug-helpers.ts:69-75` — `ALLOWED_COMMANDS` and `DANGEROUS_KEYWORDS` enumerations
- `apps/web/src/lib/server/debug-helpers.ts:80-93` — `validateSqlQuery()` — missing `INTO` from blocked keywords
- `apps/web/src/routes/api/debug/sql/+server.ts:36` — `sql.raw(query)` — unsanitized SQL execution
- `apps/web/src/hooks.server.ts:5-9` — token-based auth gate (single shared secret)

## Attacker Control

The attacker sends a POST request to `/api/debug/sql` with a JSON body containing a `sql` field. The query string is taken verbatim from the request body and passed to `sql.raw()` after minimal validation:

```typescript
// apps/web/src/routes/api/debug/sql/+server.ts:19-20
const body = await request.json() as { sql?: string };
const query = body.sql?.trim();
```

The attacker fully controls the SQL text (subject to the keyword filter).

## Trust Boundary Crossed

The debug SQL endpoint is intended to be **read-only** (as documented in the JSDoc comment: "Only SELECT, EXPLAIN, SHOW, DESCRIBE, and WITH (CTE) are allowed"). The `SELECT INTO` bypass crosses the boundary from read-only to **write-capable**, allowing table creation and data exfiltration into attacker-controlled database objects. All schema tables become writable targets.

## Impact

- **Data exfiltration**: `SELECT id, email, password_hash INTO stolen_creds FROM users` — copies the full users table into an attacker-controlled table
- **Persistent backdoor**: Attacker can create tables that persist after the debug session
- **Denial of service**: `SELECT set_config('statement_timeout', '0', false)` within the SELECT bypasses the 30-second query timeout
- **Full schema enumeration**: All tables in `packages/database/schema.ts` are readable including `sessions` (session tokens), `users` (password hashes), `pushSubscriptions` (endpoint URLs)

While the endpoint requires the `DEBUG_API_TOKEN` Bearer token, this is a single shared secret with no per-user identity or audit trail. If the token is ever leaked, weak, or committed to a repository, every table in the schema is fully accessible and writable.

## Evidence

**Validation only blocks 7 keywords — `INTO` is absent:**

```typescript
// apps/web/src/lib/server/debug-helpers.ts:75
const DANGEROUS_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE'];
```

**Validation passes for `SELECT INTO`:**

```typescript
// apps/web/src/lib/server/debug-helpers.ts:80-93
export function validateSqlQuery(query: string): { valid: true } | { valid: false; error: string } {
  const firstToken = query.split(/\s+/)[0]?.toUpperCase() ?? '';
  if (!ALLOWED_COMMANDS.has(firstToken)) { /* ... */ }

  const upperQuery = query.toUpperCase();
  for (const keyword of DANGEROUS_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(upperQuery)) {
      return { valid: false, error: `...` };
    }
  }
  return { valid: true };  // <-- SELECT INTO passes through here
}
```

**Raw execution with zero additional sanitization:**

```typescript
// apps/web/src/routes/api/debug/sql/+server.ts:36
result = await d.execute(sql`${sql.raw(query)}`);
```

**Auth gate — single shared secret, not per-user:**

```typescript
// apps/web/src/hooks.server.ts:5-8
if (event.url.pathname.startsWith('/api/debug/')) {
  const auth = event.request.headers.get('authorization');
  if (!validateDebugToken(auth, env.DEBUG_API_TOKEN)) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }
}
```

**Schema tables exposed (all are readable + writable via SELECT INTO):**

```typescript
// packages/database/schema.ts:20-30 — users table with password hashes
export const users = pgTable('users', {
  id: varchar('id', { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('user'),
  // ...
});

// packages/database/schema.ts:34-39 — sessions with tokens
export const sessions = pgTable('sessions', {
  // ...
  token: varchar('token', { length: 255 }).notNull().unique(),
  // ...
});
```

## Exploit Sketch

1. Obtain or guess the `DEBUG_API_TOKEN` (single shared secret, potentially weak or leaked)
2. Send POST to `/api/debug/sql` with header `Authorization: Bearer <token>`
3. Body: `{"sql": "SELECT id, email, password_hash INTO exfil_users FROM users"}`
4. Validation passes: first token = `SELECT`, no blocked keywords present
5. PostgreSQL executes `SELECT INTO`, creating table `exfil_users` with all user credentials
6. Read back: `{"sql": "SELECT * FROM exfil_users"}`
7. Clean up or leave backdoor: `{"sql": "SELECT * INTO permanent_backdoor FROM sessions"}`

## Open Questions

- Is `DEBUG_API_TOKEN` set in production? The `.env.example` shows a placeholder value.
- Does the PostgreSQL user have `CREATE TABLE` privileges on the `public` schema? If the database connection uses a restricted role, `SELECT INTO` may fail.
- Are there audit logs to detect table creation via `SELECT INTO`?
- Could `COPY ... TO PROGRAM` be executed within a `SELECT` (via function composition)? This may depend on PostgreSQL version and configuration.
