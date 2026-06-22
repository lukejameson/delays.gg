**Longshot anchor db875254 (apps/web/src/routes/+page.server.ts) complete. Drafts: 1.**

The anchor file is a clean, well-structured SvelteKit `+page.server.ts` load function for a public flight tracker homepage. After tracing all data flows end-to-end through imports, database queries, client-side rendering, and related routes:

- **SQL Injection**: All queries use Drizzle ORM parameterized methods; the sole user-controlled parameter (`?date=`) is strictly validated against server-generated date strings
- **XSS**: The `rv` cookie is rendered via Svelte's default escaping; no `{@html}` with untrusted data
- **Auth**: Public page by design; no auth boundaries crossed
- **SSRF / Command Injection / Path Traversal**: No dangerous sinks present
- **Secrets / Crypto**: No hardcoded secrets or weak primitives
