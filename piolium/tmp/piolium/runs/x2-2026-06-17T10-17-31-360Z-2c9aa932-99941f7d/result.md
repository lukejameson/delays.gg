Everything is in order. Here's my completion summary:

---

**Longshot anchor 2c9aa932 (apps/web/src/routes/+layout.server.ts) complete. Drafts: 1.**

**Analysis summary:** The anchor file is a SvelteKit server-side layout `load` function that:
- Ignores all request input (the event parameter is `_`)
- Uses Drizzle ORM parameterized queries (SQLi-safe) to fetch public airports data
- Reads server-controlled environment variables (`env.DOMAIN`, `PUBLIC_UMAMI_URL`, etc.)
- Returns this data to every page as layout data

No attacker-controlled input enters this function. All data sources (env vars, database) are admin-controlled. Downstream usage in `+layout.svelte` — including the `{@html}` JSON-LD block — receives only trusted data. No vulnerability chain exists from an external attacker to a dangerous sink through this file.
