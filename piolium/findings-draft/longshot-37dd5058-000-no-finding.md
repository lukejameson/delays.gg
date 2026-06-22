---
id: longshot-37dd5058-000
phase: X2
anchor: apps/web/src/routes/stats/lib/stores.ts
slug: no-finding
severity: none
confidence: high
---

## Summary

After rigorous review of the anchor file (`stores.ts`) and its entire dependency chain — `+page.svelte`, `+page.server.ts`, `lib/queries.ts`, `lib/types.ts`, `lib/transforms.ts`, `components/FilterBar.svelte`, and `$lib/server/db.ts` — no exploitable security vulnerability was found.

All URL-sourced filter parameters flow through Drizzle ORM's parameterized `sql` tagged template literal (backed by `node-postgres`), which prevents SQL injection. Svelte's template auto-escaping prevents XSS. SvelteKit's client-side `goto()` only handles internal app navigation, preventing open redirect. No file operations, command execution, deserialization, or authentication checks exist in this code path. The page is a public statistics dashboard with no sensitive data exposure concerns.

Key verification points:
- **SQL injection**: Not possible — all `sql` template interpolations are parameterized (`packages/database/index.ts:52-54`, standard Drizzle behavior)
- **XSS**: Not possible — all template expressions use Svelte's auto-escaping `{...}` with no `{@html}` usage (`+page.svelte`, `FilterBar.svelte`)
- **Open redirect**: Not possible — `buildFilterUrl()` (`stores.ts:191-210`) always constructs `/stats?...` paths; `goto()` navigates within the SvelteKit app
- **Server-side validation**: `+page.server.ts:41-43` validates `threshold` against `[0, 15, 30]`; `dow`, `month`, `year` are validated with `parseInt` range checks; unvalidated string params (airline, direction, season) are type-asserted and used only in parameterized SQL
- **Prototype pollution**: No dangerous object operations with attacker-controlled keys
- **Race conditions**: The `setInterval` polling in `createPageStore()` (`stores.ts:32-37`) is intentionally never cleared (singleton store pattern); no exploitable TOCTOU window exists between URL detection and navigation
