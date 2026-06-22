---
id: longshot-c3374319-000
phase: X2
anchor: apps/web/src/routes/stats/lib/queries.ts
slug: no-finding
severity: informational
confidence: high
---

## Summary

After rigorous review of the anchor file (`queries.ts`), its type definitions (`types.ts`), both callers (`+page.server.ts` load function and `/api/debug/ui/stats/+server.ts` API handler), the database connection layer (`@airways/database`), the auth hook (`hooks.server.ts`), and the debug helpers — no exploitable vulnerability was found.

The file contains 20+ exported async query functions that construct SQL via Drizzle ORM's `sql` template literal. Drizzle parameterizes all interpolated values (`${...}` becomes bind parameters like `$1`), preventing SQL injection. No `sql.raw()` or raw string concatenation into SQL is used anywhere in this module or its callers.

User input enters through URL query parameters in the SvelteKit `load` function (`+page.server.ts`, intentionally public) and the debug API (`/api/debug/ui/stats`, gated behind `Bearer` token via `hooks.server.ts`). All parameters undergo type validation (threshold clamped to [0,15,30], DOW to [0,6], month to [1,12], year to [2000,2100], season/direction matched against known constants). Invalid values produce empty SQL fragments with no injection surface.

All queries are read-only (`SELECT`). No mutations, no file I/O, no outbound HTTP. No secrets or credentials are embedded in the query layer. The database connection uses a connection pool with UTC enforcement and no privilege escalation surface.

The debug endpoint auth is implemented correctly: `validateDebugToken` returns `false` when `DEBUG_API_TOKEN` is unset, making the endpoint fail-closed by default.
