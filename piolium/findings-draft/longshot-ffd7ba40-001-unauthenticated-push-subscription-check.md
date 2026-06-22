---
Phase: 2
Sequence: 001
Slug: unauthenticated-push-subscription-check
Verdict: VALID
Severity-Original: MEDIUM
Confidence: high
Anchor: apps/web/src/routes/api/push/check/[flightId]/+server.ts
Anchor-Sha8: ffd7ba40
---

## Summary

The `/api/push/check/[flightId]` endpoint is completely unauthenticated, allowing anyone to query whether an arbitrary Web Push endpoint is subscribed to an arbitrary flight. Web Push endpoints are capability URLs (secrets) that uniquely identify a specific browser + application registration. This endpoint leaks the association between private push endpoints and flight tracking interests, enabling an attacker who obtains a victim's push endpoint to enumerate all flights the victim is tracking.

Additionally, the sibling `/api/push/subscribe` endpoint (POST/DELETE) is also unauthenticated, allowing unauthenticated subscription manipulation (spam, DoS). The only auth gating in the application (`hooks.server.ts`) covers `/api/debug/*` — there is no auth check for any `/api/push/*` route.

## Location

- `apps/web/src/routes/api/push/check/[flightId]/+server.ts:7-21` — anchor: the unauthenticated GET handler
- `apps/web/src/hooks.server.ts:7-12` — auth middleware (only gates `/api/debug/*`, not `/api/push/*`)
- `apps/web/src/routes/api/push/subscribe/+server.ts:7-37` — sibling unauthenticated POST handler (subscribe)
- `apps/web/src/routes/api/push/subscribe/+server.ts:39-55` — sibling unauthenticated DELETE handler (unsubscribe)
- `packages/database/schema.ts:209-224` — pushSubscriptions table schema (unique on endpoint+flightId)

## Attacker Control

The attacker controls two inputs via an unauthenticated GET request:

1. **`flightId`** — path parameter in `/api/push/check/[flightId]`. Parsed as integer, so injection-safe. However, flight IDs are sequential integers, making enumeration trivial.
2. **`endpoint`** — query parameter `?endpoint=...`. This is a Web Push API endpoint URL (e.g., `https://fcm.googleapis.com/fcm/send/...`). The endpoint is treated as a secret capability URL by the web push protocol — its value alone authorizes sending notifications to that browser.

The attacker can supply any `endpoint` value they have obtained and any `flightId` to query the subscription association.

## Trust Boundary Crossed

The Web Push endpoint URL is a **capability URL** — possession of the URL grants the ability to send push messages to that specific browser instance. The W3C Push API specification states: *"The push subscription's endpoint MUST NOT give any information about the user agent, client, or push service."* The endpoint is expected to be confidential to the user agent and the application server.

This endpoint crosses the trust boundary by:
1. Allowing **any caller** (not just the owning browser) to query which flights are associated with a push endpoint
2. Exposing a boolean oracle (`subscribed: true/false`) that reveals whether a specific (endpoint, flight) association exists
3. Having no authentication, authorization, or rate limiting to prevent enumeration

## Impact

- **Privacy violation**: An attacker who obtains a victim's push endpoint (e.g., via XSS on a co-origin page, through client-side script access, or via logging/analytics leaks) can enumerate all flights the victim is tracking on airways.gg, revealing their travel interests and patterns.
- **Subscription enumeration**: An attacker can brute-force flight IDs (sequential integers) against known endpoints to build a profile of which flights are being tracked.
- **Broader push subsystem abuse**: The adjacent unauthenticated `/api/push/subscribe` endpoint allows subscribe/unsubscribe manipulation, enabling notification spam and denial of service against legitimate users.

## Evidence

**Anchor — unauthenticated GET handler** (`apps/web/src/routes/api/push/check/[flightId]/+server.ts:7-21`):
```typescript
export const GET: RequestHandler = async ({ params, url }) => {
  const flightId = parseInt(params.flightId, 10);
  if (isNaN(flightId)) throw error(400, 'Invalid flightId');

  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) throw error(400, 'Missing endpoint');

  const db = getDb();
  const rows = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.flightId, flightId), eq(pushSubscriptions.endpoint, endpoint)))
    .limit(1);

  return json({ subscribed: rows.length > 0 });
};
```
No auth check, no session validation, no CSRF token, no rate limiting.

**Auth middleware — only protects /api/debug/** (`apps/web/src/hooks.server.ts:7-12`):
```typescript
if (event.url.pathname.startsWith('/api/debug/')) {
    const auth = event.request.headers.get('authorization');
    if (!validateDebugToken(auth, env.DEBUG_API_TOKEN)) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }
}
```
No check for `/api/push/` routes. The push endpoints are completely open.

**Sibling subscribe endpoint — also unauthenticated** (`apps/web/src/routes/api/push/subscribe/+server.ts:7-37`):
```typescript
export const POST: RequestHandler = async ({ request }) => {
  let body: { subscription: PushSubscription; flightId: number; flightCode: string; flightDate: string };
  // ... parses body, inserts into pushSubscriptions ...
  return json({ ok: true });
};
```
No auth check. Anyone can subscribe any endpoint to any flight.

**Sibling unsubscribe endpoint — also unauthenticated** (`apps/web/src/routes/api/push/subscribe/+server.ts:39-55`):
```typescript
export const DELETE: RequestHandler = async ({ request }) => {
  // ... deletes from pushSubscriptions by endpoint+flightId ...
  return json({ ok: true });
};
```
No auth check. Anyone can unsubscribe any endpoint from any flight.

**No layout-level auth for push routes** — no `+layout.server.ts` exists under `apps/web/src/routes/api/push/`.

## Exploit Sketch

1. Attacker obtains a victim's Web Push endpoint URL (via XSS on the airways.gg origin, client-side JS inspection, leaked logs, or any mechanism that exposes `PushSubscription.endpoint`).
2. Attacker iterates over flight IDs (integers 1, 2, 3, ...) and calls:
   ```
   GET /api/push/check/<flightId>?endpoint=<victim_endpoint>
   ```
3. For each `subscribed: true` response, the attacker records that the victim is tracking that flight.
4. The attacker now has a list of flights the victim cares about — revealing travel patterns, airlines of interest, and potential future travel plans.
5. Alternatively, the attacker can use the subscribe endpoint to register the victim's endpoint for arbitrary flights, causing unwanted push notifications.

## Open Questions

- Can push endpoints realistically leak? They are sent over HTTPS in request bodies and are not part of URLs. However, they are accessible to any JavaScript running on the same origin (via `navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription())`), so an XSS on airways.gg would expose them.
- Is there a user authentication system planned? The application appears to have no user accounts (no users table is referenced in the web app's `$lib/server/db.ts` re-export), so adding auth would require architectural changes.
- Rate limiting is absent — even without auth, rate limiting could slow enumeration attacks. Confirm whether a reverse proxy or CDN provides rate limiting in production.
