**Longshot anchor cad49483 (apps/web/src/routes/api/debug/flight-notes/+server.ts) complete. Drafts: 1.**

**Finding summary:**

- **`longshot-cad49483-001` — Auth Bypass via `%2F` URL Encoding (HIGH, high confidence)**: The debug API auth gate in `hooks.server.ts` uses `event.url.pathname.startsWith('/api/debug/')` to protect all `/api/debug/*` endpoints. However, SvelteKit preserves `%2F` (encoded `/`) in `event.url.pathname` while simultaneously routing encoded paths to the same handlers — the route pattern regex in `routing.js` explicitly converts `/` to `%2[Ff]`. An attacker can bypass authentication on all 17 debug endpoints by substituting `%2F` for `/` in the URL path (e.g., `GET /api%2Fdebug%2Fflight-notes`). The most severe escalation target is `/api/debug/sql`, which accepts arbitrary SELECT queries against the database.
