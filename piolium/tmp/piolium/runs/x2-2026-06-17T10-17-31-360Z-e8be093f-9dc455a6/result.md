Longshot anchor e8be093f (packages/database/schema.ts) complete. Drafts: 2.

**Summary of findings:**

1. **longshot-e8be093f-001-select-into-bypass.md** (HIGH, high confidence): The `/api/debug/sql` endpoint uses `sql.raw()` with a `validateSqlQuery()` function that blocks INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE but misses PostgreSQL's `SELECT ... INTO ...` syntax, which creates new tables from query results. An attacker with the debug API token can bypass the read-only restriction entirely, creating tables to exfiltrate data from all schema-defined tables (`users`, `sessions`, etc.).

2. **longshot-e8be093f-002-hardcoded-secrets-env-committed.md** (CRITICAL, high confidence): The `.env` file is tracked in git (not in `.gitignore`), exposing `DATABASE_URL` (with credentials), `DEBUG_API_TOKEN`, `VAPID_PRIVATE_KEY`, `SESSION_SECRET`, and multiple API keys. This directly enables the `SELECT INTO` bypass and grants full database access to all tables in the schema.
