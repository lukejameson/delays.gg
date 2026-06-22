---
Phase: 3
Sequence: 008
Slug: blind-ssrf-push-subscription-endpoint
Verdict: VALID
Severity-Original: MEDIUM
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-a7b59fb0-001-ssrf-push-subscription-endpoint.md
---

## Summary

The push notification dispatcher makes HTTPS POST requests to user-supplied endpoint URLs stored in the `push_subscriptions` table without any URL validation. An attacker can subscribe to push notifications with a crafted endpoint pointing to an internal HTTPS service (e.g., `https://internal-service.corp:8443/admin`), causing the notification service to make authenticated outbound requests to arbitrary hosts. This is a blind SSRF — the attacker controls hostname, port, and path but is limited to HTTPS via the `web-push` library.

## Affected Files

- `apps/notification-service/src/dispatcher.ts:96-99` — `webpush.sendNotification(sub.subscription, payload)` — the sink
- `apps/notification-service/src/dispatcher.ts:78-83` — subscription read from DB and iterated without URL validation
- `apps/web/src/routes/api/push/subscribe/+server.ts:20-31` — stores user-submitted `subscription.endpoint` with no URL validation
- `node_modules/web-push/src/web-push-lib.js:338-380` — `sendNotification` calls `https.request()` with parsed endpoint URL directly

## Root Cause

Push subscription endpoint URLs originate from unauthenticated external HTTP clients (the public `/api/push/subscribe` endpoint) and are stored without any URL validation (scheme, hostname allowlisting, IP range restriction). The notification dispatcher later reads these URLs and passes them directly to `https.request()` with no validation.

## Attacker Control

The attacker sends a POST to `/api/push/subscribe` (unauthenticated) with:
```json
{
  "subscription": {
    "endpoint": "https://internal-service.corp.example.com:8443/admin",
    "keys": { "p256dh": "...", "auth": "..." }
  },
  "flightId": 123,
  "flightCode": "GR601",
  "flightDate": "2026-06-17"
}
```

## Impact

- **Blind SSRF**: Server makes HTTPS POST requests to arbitrary internal hosts reachable from the notification service's network
- **Internal network reconnaissance**: By providing different internal hostnames and observing error logs, attacker can map internal services
- **Limited by HTTPS-only**: The `web-push` library uses `https.request()`, so only HTTPS targets are reachable
- **Payload is WebPush-encrypted flight status**: Not sensitive secrets, but VAPID Authorization header is included

## Evidence

**Unvalidated storage** (`apps/web/src/routes/api/push/subscribe/+server.ts:14-23`):
```typescript
const { subscription, flightId, flightCode, flightDate } = body;
if (!subscription?.endpoint || !flightId || !flightCode || !flightDate) {
  throw error(400, 'Missing required fields');
}
await db.insert(pushSubscriptions).values({
  endpoint: subscription.endpoint,
  subscription: subscription as unknown as Record<string, unknown>,
  // ...
})
```

**Unvalidated use in dispatcher** (`apps/notification-service/src/dispatcher.ts:96-99`):
```typescript
await webpush.sendNotification(
  sub.subscription as webpush.PushSubscription,
  payload,
);
```

**web-push sends HTTPS to endpoint** (`node_modules/web-push/src/web-push-lib.js:345-354`):
```javascript
const urlParts = url.parse(requestDetails.endpoint);
httpsOptions.hostname = urlParts.hostname;
httpsOptions.port = urlParts.port;
httpsOptions.path = urlParts.path;
const pushRequest = https.request(httpsOptions, ...);
```

## Exploit Sketch

1. POST to `/api/push/subscribe` with `endpoint: "https://internal-api.corp:8443/health"` and a valid `flightId`
2. Wait for the notification dispatcher to process a status update for that flight (scrapers run periodically)
3. Dispatcher makes HTTPS POST to the internal target with VAPID Authorization header
4. Attacker cannot directly read the response but can infer success/failure from error patterns or timing

## Confidence Notes

HIGH confidence — the full data flow from unauthenticated POST to `https.request()` is traced. The HTTPS-only limitation constrains severity. The attack requires the notification dispatcher to process the subscription, which depends on scraper-triggered flight status updates for the chosen flight ID.
