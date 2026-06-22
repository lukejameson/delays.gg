---
id: longshot-2c9aa932-000
phase: X2
anchor: apps/web/src/routes/+layout.server.ts
slug: no-finding
severity: none
confidence: high
---

## Summary

The `+layout.server.ts` anchor file is a SvelteKit server-side layout load function that fetches airports from the database (via Drizzle ORM parameterized queries — SQLi-safe), reads server-side and public environment variables, and returns this data to every page. The load function ignores the SvelteKit event parameter entirely — no user-controlled input enters the function. All data sources are server-controlled (env vars set by the administrator, database contents). No attacker-controlled data flows into any sensitive sink through this file. The downstream `{@html}` block in `+layout.svelte` (line 43), which renders JSON-LD structured data via `JSON.stringify`, receives only `siteUrl` constructed from the admin-set `env.DOMAIN`. No vulnerability chain exists from an external attacker to a dangerous sink anchored on this file.
