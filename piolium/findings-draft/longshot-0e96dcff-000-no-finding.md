---
id: longshot-0e96dcff-000
phase: X2
anchor: apps/web/src/routes/api/debug/push-subs/+server.ts
slug: no-finding
severity: informational
confidence: high
---

## Summary

After rigorous review of the anchor file (`apps/web/src/routes/api/debug/push-subs/+server.ts`), the debug helpers (`apps/web/src/lib/server/debug-helpers.ts`), the auth hooks (`apps/web/src/hooks.server.ts`), the database schema (`packages/database/schema.ts` line 209-222), the push subscribe endpoint (`apps/web/src/routes/api/push/subscribe/+server.ts`), the notification dispatcher (`apps/notification-service/src/dispatcher.ts`), and all neighboring debug endpoints, no exploitable vulnerability was found in or anchored on this file.

**Why clean:**

- **Auth**: All `/api/debug/*` routes are gated behind `Authorization: Bearer <DEBUG_API_TOKEN>` via the centralized `handle` hook at `apps/web/src/hooks.server.ts:7-12`. The `validateDebugToken` function at `apps/web/src/lib/server/debug-helpers.ts:97-102` uses strict string equality and is fail-closed — returns `false` when the token env var is unset or the auth header is missing/malformed. No route-level auth bypass is possible; SvelteKit always runs the `handle` hook before route handlers.

- **SQL Injection**: All query conditions (`eq`, `gte`, `lte`, `and`) use Drizzle ORM's parameterized query builders. No `sql.raw()`, no string concatenation into SQL. The `flightId` is parsed via `parseInt` to a number; `flightCode` is uppercased; `dateFrom`/`dateTo` are passed as bound parameters to `gte`/`lte`. Drizzle ORM generates parameterized SQL (`SELECT * FROM push_subscriptions WHERE ... $1, $2, ...`), eliminating SQL injection risk.

- **No sort/column injection**: Sort direction is a binary choice (`'asc'` → `asc`, everything else → `desc`), both Drizzle symbols. Sort column is hardcoded to `pushSubscriptions.createdAt` — no user-controlled column name.

- **Pagination**: `parsePagination` at `apps/web/src/lib/server/debug-helpers.ts:42-55` clamps `limit` to [1, 1000] and `offset` to [0, ∞), handling NaN/negative values gracefully.

- **Error handling**: The `catch` block returns `debugError('Query failed', 500)` — actual errors are logged server-side via `console.error` but not exposed to the client.

- **No path traversal / casing bypass**: SvelteKit normalizes URLs before the `startsWith('/api/debug/')` prefix check. No `+layout.server.ts` exists in the debug route group to override or bypass the hook.

- **Information exposure**: The endpoint returns `db.select()` (SELECT *) including the `subscription` jsonb column (`packages/database/schema.ts:211`) which contains Web Push subscription data. This is by design for debugging push notification issues. The data is protected by Bearer token auth. Without the VAPID private key (stored only in environment variables, never in the database — confirmed by `grep VAPID packages/database/` returning zero results), the subscription data alone cannot be used to send push notifications. The `users` and `sessions` tables were intentionally excluded from the debug API for containing `password_hash` and `session tokens` (`.plans/build-a-secure-apidebug-endpoint-grou/todo.yaml:90`); `push_subscriptions` was deliberately included as operational data needed for debugging.

**Note on neighboring endpoints**: The `/api/debug/sql` endpoint has known bypasses via comment injection (`longshot-16201ecf-001`) and PostgreSQL meta-command functions (`longshot-5a090d12-001`). These are documented for their respective anchors and are not applicable to this file, which uses Drizzle ORM exclusively with no raw SQL path.
