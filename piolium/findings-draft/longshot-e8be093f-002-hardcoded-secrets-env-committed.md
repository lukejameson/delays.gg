---
Phase: 2
Sequence: 002
Slug: hardcoded-secrets-env-committed
Verdict: VALID
Severity-Original: CRITICAL
Confidence: high
Anchor: packages/database/schema.ts
Anchor-Sha8: e8be093f
---

## Summary

The `.env` file containing database credentials, API keys, the debug API token, VAPID private keys, proxy credentials, and session secrets is tracked in git (not in `.gitignore`). This directly enables the `SELECT INTO` bypass in the debug SQL endpoint (see draft 001) because the `DEBUG_API_TOKEN` is publicly visible in the repository history. The `DATABASE_URL` with credentials (`manga_user:manga_password`) is also exposed, granting full database access to anyone who can access the repository. The schema file `packages/database/schema.ts` defines the full database structure that becomes accessible via these exposed credentials.

## Location

- `/data/repos/airways.gg/.env:1-90` — committed secrets file
- `/data/repos/airways.gg/.gitignore:1-5` — missing `.env` entry
- `packages/database/schema.ts:1-202` — schema tables accessible via exposed DATABASE_URL

## Attacker Control

Anyone with access to the git repository (public or private with leaked access) can read the committed `.env` file and extract all credentials. No exploitation required — the secrets are available in the source code history.

## Trust Boundary Crossed

Repository source code → production infrastructure. Secrets intended to be runtime-only environment variables are persisted in version control, crossing the boundary from development artifacts to operational credentials.

## Impact

- **Full database compromise**: `DATABASE_URL=postgres://manga_user:manga_password@localhost:5432/airwaysgg` — direct database access to all tables defined in `packages/database/schema.ts` including `users` (password hashes), `sessions` (session tokens), and all flight data
- **Debug API token exposure**: `DEBUG_API_TOKEN=ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1` — enables the `SELECT INTO` bypass (draft 001)
- **Push notification hijacking**: `VAPID_PRIVATE_KEY=ciNzpkSvohYPLQTWQaHDxOB5OyRfqXU-2wLH5vCOILQ` — allows sending arbitrary push notifications as the application
- **API key compromise**: FR24 API token, Guernsey API key, proxy credentials all exposed
- **Session hijacking**: `SESSION_SECRET=airways-gg-local-dev-secret-change-in-prod` — weak session secret enables session forgery

## Evidence

**`.env` tracked by git (not in `.gitignore`):**

```
$ git ls-files .env
.env
```

**`.gitignore` lacks `.env` entry:**

```gitignore
# /data/repos/airways.gg/.gitignore:1-5
# Dependencies
node_modules/
alpha_testing/
orignal_scraper/
```

**Exposed database credentials:**

```bash
# /data/repos/airways.gg/.env:2
DATABASE_URL=postgres://manga_user:manga_password@localhost:5432/airwaysgg
```

**Exposed debug token (enables draft 001 bypass):**

```bash
# /data/repos/airways.gg/.env:90
DEBUG_API_TOKEN=ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1
```

**Exposed VAPID private key:**

```bash
# /data/repos/airways.gg/.env:62
VAPID_PRIVATE_KEY=ciNzpkSvohYPLQTWQaHDxOB5OyRfqXU-2wLH5vCOILQ
```

**Exposed session secret:**

```bash
# /data/repos/airways.gg/.env:7
SESSION_SECRET=airways-gg-local-dev-secret-change-in-prod
```

**Schema tables that become accessible:**

```typescript
// packages/database/schema.ts:20-30
export const users = pgTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: userRoleEnum('role').notNull().default('user'),
  ...
});

// packages/database/schema.ts:34-39
export const sessions = pgTable('sessions', {
  ...
  token: varchar('token', { length: 255 }).notNull().unique(),
  ...
});
```

## Exploit Sketch

1. Clone or access the repository
2. Read `.env` from the working tree or `git show HEAD:.env`
3. Extract `DATABASE_URL` containing `manga_user:manga_password`
4. Connect directly to the PostgreSQL database using these credentials
5. Execute arbitrary SQL against all schema-defined tables: `SELECT * FROM users`, `SELECT * FROM sessions`, etc.
6. Use `DEBUG_API_TOKEN` to access the `/api/debug/sql` endpoint and exploit the `SELECT INTO` bypass (draft 001)
7. Use `VAPID_PRIVATE_KEY` to send malicious push notifications to all subscribed users
8. Use `SESSION_SECRET` to forge session cookies and impersonate users

## Open Questions

- Are these credentials used in production, or only in a development/staging environment? Some values (like `GUERNSEY_API_KEY=92873426` and `FR24_API_TOKEN=...`) appear to be non-placeholder values that may be real API keys.
- Is the git repository public or private? If public, these credentials are immediately available to anyone.
- Have these credentials been rotated? Simply removing `.env` from git history is insufficient — all exposed keys must be rotated.
- What is the blast radius of the `AURIGNY_OTP2_TOKEN` and `CF_CLEARANCE_COOKIE` values? These appear to be live authentication tokens.
