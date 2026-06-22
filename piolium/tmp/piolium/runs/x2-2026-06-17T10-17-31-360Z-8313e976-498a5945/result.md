All tasks complete. Here's the summary:

**Longshot anchor 8313e976 (`apps/web/src/routes/api/debug/historical-weather/+server.ts`) complete. Drafts: 1.**

**Analysis summary:**

- The `/api/debug/historical-weather` endpoint is a read-only GET handler that queries the `historical_weather` table via Drizzle ORM with fully parameterized bindings — zero SQL injection risk.
- Authentication is globally enforced at `hooks.server.ts:9-12` for all `/api/debug/*` routes via Bearer token validation against the `DEBUG_API_TOKEN` env var. The auth fails closed (401) when the token is unset.
- Input validation: `parsePagination` clamps limit to 1–1000 and offset ≥0; sort order is constrained to `asc`/`desc`; airport codes are uppercased; date parameters are safely parsed via `new Date()`.
- No command execution, file I/O, deserialization, SSRF, or prototype pollution surface exists on this handler.
- After tracing the full call chain through `debug-helpers.ts`, `hooks.server.ts`, `db.ts`, and `database/schema.ts`, no exploitable vulnerability was identified.
