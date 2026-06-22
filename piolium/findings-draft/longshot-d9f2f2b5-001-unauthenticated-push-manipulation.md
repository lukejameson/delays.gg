---
Phase: 2
Sequence: 001
Slug: unauthenticated-push-manipulation
Verdict: VALID
Severity-Original: HIGH
Confidence: high
Anchor: apps/web/src/routes/api/push/subscribe/+server.ts
Anchor-Sha8: d9f2f2b5
---

## Summary

The `/api/push/subscribe` endpoint (both POST for subscribe and DELETE for unsubscribe) has **no authentication**. The application's only auth gate (`hooks.server.ts`) covers `/api/debug/*` but leaves `/api/push/*` wide open. Any remote, unauthenticated attacker can subscribe or unsubscribe any Web Push endpoint from any flight, enabling spam, denial of service, and unauthorized unsubscription of legitimate users. The sibling `/api/push/check/[flightId]` GET endpoint is similarly unprotected, leaking whether a given endpoint is subscribed to a given flight.

## Location

- `apps/web/src/routes/api/push/subscribe/+server.ts:6-37` — unauthenticated POST handler (subscribe)
- `apps/web/src/routes/api/push/subscribe/+server.ts:39-55` — unauthenticated DELETE handler (unsubscribe)
- `apps/web/src/routes/api/push/check/[flightId]/+server.ts:6-21` — unauthenticated GET handler (subscription check)
- `apps/web/src/hooks.server.ts:7-13` — auth gate that only covers `/api/debug/*`, proving push endpoints are excluded

## Attacker Control

The attacker sends an unauthenticated HTTP request:

**Subscribe (POST):**
```json
POST /api/push/subscribe
{
  "subscription": { "endpoint": "https://...", "keys": {...} },
  "flightId": 123,
  "flightCode": "GR601",
  "flightDate": "2026-06-17"
}
```

**Unsubscribe (DELETE):**
```json
DELETE /api/push/subscribe
{
  "endpoint": "https://victim-push-endpoint.example.com/...",
  "flightId": 123
}
```

**Check (GET):**
```
GET /api/push/check/123?endpoint=https://victim-push-endpoint.example.com/...
```

No cookies, tokens, or authentication headers are required. The server processes these requests unconditionally.

## Trust Boundary Crossed

Crosses the **internet → application trust boundary**. The push subscription endpoints are intended for authenticated browser users who have explicitly opted into notifications via `Notification.requestPermission()`. In the legitimate flow (`NotifyButton.svelte:94-98`), the client-side component sends `flightCode` and `flightDate` from server-rendered page props, and the `PushSubscription` from the browser's Push API. There is no server-side authentication that binds the request to the authenticated user session.

## Impact

1. **Subscription Spam / Database Poisoning**: An attacker can flood the `push_subscriptions` table with arbitrary entries using any valid-looking PushSubscription. While the attacker cannot receive notifications for subscriptions they don't control (web-push uses endpoint-specific encryption keys), they can:
   - Fill the database with junk rows, degrading query performance
   - Create subscriptions with non-existent `flightId` values that fail the FK constraint but waste resources
   - Create subscriptions that will never be notified, which will later appear as "dead push subs" in health monitoring and skew health reports

2. **Unauthorized Unsubscription (DoS against legitimate users)**: If an attacker discovers a legitimate user's push endpoint URL (which is somewhat guessable — they follow patterns like `https://fcm.googleapis.com/fcm/send/...` or `https://updates.push.services.mozilla.com/...`), the attacker can unsubscribe that endpoint from any or all flights, preventing the victim from receiving status update notifications.

3. **Subscription Status Probing (Privacy Leak)**: The unprotected `GET /api/push/check/[flightId]` endpoint confirms whether a given endpoint is subscribed to a specific flight, enabling enumeration attacks.

4. **LLM Prompt Injection (see companion finding 002)**: The unauthenticated `flightCode` field flows through the health monitor into the DeepSeek LLM prompt, enabling prompt injection attacks.

## Evidence

**Auth gate only covers `/api/debug/*`** (`apps/web/src/hooks.server.ts:7-13`):
```typescript
export const handle: Handle = async ({ event, resolve }) => {
  // Debug API auth — gate /api/debug/* behind Bearer token
  if (event.url.pathname.startsWith('/api/debug/')) {
    const auth = event.request.headers.get('authorization');
    if (!validateDebugToken(auth, env.DEBUG_API_TOKEN)) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  // ...rest of handler — no auth for /api/push/*
```

**No auth on POST subscribe** (`apps/web/src/routes/api/push/subscribe/+server.ts:6-37`):
```typescript
export const POST: RequestHandler = async ({ request }) => {
  // No auth check — directly parses body and inserts into DB
  let body: { subscription: PushSubscription; flightId: number; flightCode: string; flightDate: string };
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const { subscription, flightId, flightCode, flightDate } = body;
  if (!subscription?.endpoint || !flightId || !flightCode || !flightDate) {
    throw error(400, 'Missing required fields');
  }
  const db = getDb();
  await db.insert(pushSubscriptions).values({...}).onConflictDoUpdate({...});
  return json({ ok: true });
};
```

**No auth on DELETE unsubscribe** (`apps/web/src/routes/api/push/subscribe/+server.ts:39-55`):
```typescript
export const DELETE: RequestHandler = async ({ request }) => {
  // No auth check — directly parses body and deletes from DB
  let body: { endpoint: string; flightId: number };
  // ...parses, validates, deletes unconditionally
};
```

**No auth on GET check** (`apps/web/src/routes/api/push/check/[flightId]/+server.ts:6-21`):
```typescript
export const GET: RequestHandler = async ({ params, url }) => {
  // No auth check — directly queries subscription status
  const flightId = parseInt(params.flightId, 10);
  const endpoint = url.searchParams.get('endpoint');
  // ...queries and returns { subscribed: true/false }
};
```

## Exploit Sketch

1. **Spam/DoS**: An attacker scripts repeated POSTs to `/api/push/subscribe` with varying `endpoint` URLs and `flightId` values (some valid, some invalid), filling the `push_subscriptions` table with junk. The notification dispatcher will attempt to process these subscriptions, wasting CPU and network resources on failed web-push deliveries.

2. **Silent Unsubscription**: An attacker identifies a victim's push endpoint URL (e.g., through browser inspection, traffic analysis, or by enumerating known push service URL patterns). The attacker sends DELETE requests to unsubscribe the victim's endpoint from all flights of interest. The victim stops receiving notifications without any indication.

3. **Enumeration**: An attacker probes `GET /api/push/check/<flightId>?endpoint=<target>` for multiple flight IDs and endpoints to map which users are tracking which flights.

## Open Questions

- Is there a session/cookie-based auth mechanism elsewhere in the app that could be extended to cover push endpoints? The `hooks.server.ts` currently has no session handling. If a future release adds user accounts, these endpoints would need auth retrofitted.
- Can push endpoint URLs be enumerated? FCM endpoints contain opaque tokens, making guessing infeasible. Mozilla autopush endpoints are similarly opaque. However, if endpoint URLs leak through other channels (e.g., the debug push-subs endpoint, which *is* auth-gated), targeted unsubscription becomes possible.
- No rate limiting was found on these endpoints — the blast radius for spam/DoS is essentially unbounded.
