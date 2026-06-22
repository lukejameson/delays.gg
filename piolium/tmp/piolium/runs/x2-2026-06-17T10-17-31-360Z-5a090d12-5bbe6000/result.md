The audit of `apps/web/src/hooks.server.ts` is complete. Here's my summary:

**Anchor**: `apps/web/src/hooks.server.ts` — the SvelteKit server hook handling debug API auth gating and Cache-Control headers.

**Finding**: The auth gate itself is correctly implemented, but it gates access to `/api/debug/sql` which has a **HIGH-severity SQL validation bypass**. The `validateSqlQuery()` function only checks the first token (SELECT/EXPLAIN/etc.) and blocks a short list of keywords — but PostgreSQL's built-in meta-command functions like `pg_read_file()`, `pg_read_binary_file()`, `pg_ls_dir()`, `pg_sleep()`, `pg_terminate_backend()`, and `current_setting()` are all valid SELECT queries that pass validation. The validated query reaches `sql.raw()` (Drizzle's raw SQL injection point) and is executed directly against PostgreSQL, allowing file read, directory enumeration, DoS, and config disclosure — well beyond the intended "read-only database query" scope.

**Rejected leads**: timing side-channel on the Bearer token comparison (network jitter masks nanosecond differences), Cache-Control header manipulation (client controls own cache, no trust boundary), error logging in `handleError` (errors from app code, not user input), URL normalization bypass (SvelteKit normalizes paths).

---

Longshot anchor 5a090d12 (apps/web/src/hooks.server.ts) complete. Drafts: 1.
