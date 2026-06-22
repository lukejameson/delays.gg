---
Phase: 3
Sequence: 004
Slug: unauthenticated-push-api-endpoints
Verdict: VALID
Severity-Original: HIGH
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-d9f2f2b5-001-unauthenticated-push-manipulation.md
  - piolium/findings-draft/longshot-ffd7ba40-001-unauthenticated-push-subscription-check.md
---

## Summary

All `/api/push/*` endpoints — subscribe (POST), unsubscribe (DELETE), and subscription check (GET) — have no authentication whatsoever. The application's sole auth gate in `hooks.server.ts` only covers `/api/debug/*`, leaving push endpoints completely open to unauthenticated remote attackers. This allows arbitrary push subscription manipulation (spam, DoS), unauthorized unsubscription of legitimate users, and privacy-violating enumeration of which push endpoints are tracking which flights.

## Affected Files

- `apps/web/src/routes/api/push/subscribe/+server.ts:6-55` — unauthenticated POST (subscribe) and DELETE (unsubscribe) handlers
- `apps/web/src/routes/api/push/check/[flightId]/+server.ts:7-21` — unauthenticated GET handler (subscription check)
- `apps/web/src/hooks.server.ts:7-13` — auth gate that only covers `/api/debug/*`, proving push endpoints are intentionally or accidentally excluded

## Root Cause

The auth middleware in `hooks.server.ts` uses a path-prefix check (`startsWith('/api/debug/')`) that does not cover `/api/push/` routes. There is no separate authentication, CSRF protection, or rate limiting on any push endpoint. The push subscription flow was designed for client-side browser code (via `NotifyButton.svelte`) but never had server-side authentication retrofitted.

## Attacker Control

Unauthenticated HTTP requests to:

- `POST /api/push/subscribe` — body: `{"subscription": {...}, "flightId": N, "flightCode": "XX", "flightDate": "YYYY-MM-DD"}`
- `DELETE /api/push/subscribe` — body: `{"endpoint": "<url>", "flightId": N}`
- `GET /api/push/check/<flightId>?endpoint=<url>`

No cookies, tokens, or headers required.

## Impact

- **Subscription spam / database pollution**: Attacker floods `push_subscriptions` table with arbitrary entries, degrading query performance and skewing health monitor metrics (dead push sub detection)
- **Unauthorized unsubscription (DoS)**: If an attacker obtains a victim's push endpoint URL, they can unsubscribe it from all flights, silently preventing the victim from receiving notifications
- **Privacy violation**: `GET /api/push/check/<flightId>?endpoint=<url>` reveals whether a given push endpoint is subscribed to a given flight, enabling flight-tracking enumeration against known endpoints
- **LLM prompt injection vector**: The unauthenticated `flightCode` field flows into the health monitor's LLM analysis pipeline (documented separately in curated finding 005)

## Evidence

**Auth gate — only /api/debug/** (`apps/web/src/hooks.server.ts:7-13`):
```typescript
if (event.url.pathname.startsWith('/api/debug/')) {
    // ... auth check ...
}
// No check for /api/push/
```

**POST subscribe — no auth** (`apps/web/src/routes/api/push/subscribe/+server.ts:6-37`):
```typescript
export const POST: RequestHandler = async ({ request }) => {
  let body: { subscription: PushSubscription; flightId: number; flightCode: string; flightDate: string };
  // ... no auth check, no session validation, no CSRF ...
  await db.insert(pushSubscriptions).values({...}).onConflictDoUpdate({...});
  return json({ ok: true });
};
```

**DELETE unsubscribe — no auth** (`apps/web/src/routes/api/push/subscribe/+server.ts:39-55`):
```typescript
export const DELETE: RequestHandler = async ({ request }) => {
  // ... no auth check ...
  await db.delete(pushSubscriptions).where(...);
  return json({ ok: true });
};
```

**GET check — no auth** (`apps/web/src/routes/api/push/check/[flightId]/+server.ts:7-21`):
```typescript
export const GET: RequestHandler = async ({ params, url }) => {
  // ... no auth check ...
  return json({ subscribed: rows.length > 0 });
};
```

## Exploit Sketch

1. **Spam**: Script repeated POSTs to `/api/push/subscribe` with varying endpoint URLs and flight IDs, filling the table with junk
2. **Silent unsubscribe**: Obtain victim's push endpoint (via XSS on same origin or other leak), send DELETE to `/api/push/subscribe` for each flight the victim tracks
3. **Enumeration**: Iterate flight IDs against known push endpoints via `GET /api/push/check/<id>?endpoint=<url>` to build tracking profiles

## Confidence Notes

HIGH confidence — the absence of authentication is directly visible in the source code. The auth gate's path-prefix limitation is unambiguous. All three endpoint handlers (POST, DELETE, GET) were verified to have zero auth checks. No rate limiting was found on any push endpoint.
