---
Phase: 2
Sequence: 1
Slug: ssrf-push-subscription-endpoint
Verdict: VALID
Severity-Original: MEDIUM
Confidence: high
Anchor: apps/notification-service/src/dispatcher.ts
Anchor-Sha8: a7b59fb0
---

## Summary

The push notification dispatcher makes HTTPS requests to user-supplied endpoints stored in the `push_subscriptions` table without any URL validation. An attacker can subscribe to push notifications with a crafted endpoint pointing to an internal HTTPS service, causing the server to make authenticated outbound requests to arbitrary hosts (blind SSRF). The endpoint reaches `webpush.sendNotification()` which calls `https.request()` using the raw stored URL.

## Location

- `apps/notification-service/src/dispatcher.ts:96-99` — `webpush.sendNotification(sub.subscription as webpush.PushSubscription, payload)` — the sink
- `apps/notification-service/src/dispatcher.ts:78-83` — subscription is read from DB and iterated
- `apps/web/src/routes/api/push/subscribe/+server.ts:20-31` — POST handler stores user-submitted `subscription` (including `endpoint`) into `push_subscriptions` table, with no URL validation
- `apps/web/src/routes/api/push/subscribe/+server.ts:14-16` — only checks that `subscription?.endpoint` is truthy, not that it's a valid push service URL
- `node_modules/web-push/src/web-push-lib.js:338-380` — `sendNotification` calls `https.request()` with `url.parse(requestDetails.endpoint)` directly
- `node_modules/web-push/src/web-push-lib.js:88-93` — `generateRequestDetails` validates only that `subscription.endpoint` is a non-empty string

## Attacker Control

The attacker sends a POST to `/api/push/subscribe` (unauthenticated) with a JSON body where `subscription.endpoint` is set to an attacker-chosen HTTPS URL:

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

The `flightId` can be any valid flight ID, easily enumerable from the public flight listing. The `keys.p256dh` and `keys.auth` can be arbitrary values (they're only used for payload encryption).

## Trust Boundary Crossed

The push subscription endpoint URLs come from unauthenticated external HTTP clients (the public `/api/push/subscribe` endpoint with no auth or CSRF protection) and flow into a server-side outbound HTTPS request made by the notification service. This crosses the boundary between untrusted user input and server-initiated network requests.

## Impact

- **Blind SSRF**: The server makes HTTPS POST requests to arbitrary internal hosts reachable from the notification service's network. The attacker controls the hostname, port, and path.
- **Internal network reconnaissance**: By providing different internal hostnames and observing timing/errors (the dispatcher logs errors), an attacker can map internal services.
- **Limited by HTTPS-only**: The `web-push` library uses `https.request()`, so only HTTPS targets are reachable (no plain HTTP to internal services, no gopher/dict/etc).
- **Payload**: The POST body is WebPush-encrypted flight status data. The attacker controls the encryption keys, so they can decrypt the payload — but the payload content is limited to flight status messages, not sensitive secrets.

## Evidence

**Unvalidated storage in subscribe endpoint** (`apps/web/src/routes/api/push/subscribe/+server.ts:14-23`):
```typescript
const { subscription, flightId, flightCode, flightDate } = body;
if (!subscription?.endpoint || !flightId || !flightCode || !flightDate) {
  throw error(400, 'Missing required fields');
}

const db = getDb();
await db
  .insert(pushSubscriptions)
  .values({
    endpoint: subscription.endpoint,
    subscription: subscription as unknown as Record<string, unknown>,
    flightId,
    flightCode,
    flightDate,
  })
```

Only `subscription.endpoint` being truthy is checked — no URL scheme, hostname allowlisting, or IP validation.

**Unvalidated use in dispatcher** (`apps/notification-service/src/dispatcher.ts:78-99`):
```typescript
const subs = await db
  .select()
  .from(pushSubscriptions)
  .where(inArray(pushSubscriptions.flightId, flightIds));

// ...

subs.map(async (sub) => {
  // ...
  try {
    await webpush.sendNotification(
      sub.subscription as webpush.PushSubscription,
      payload,
    );
```

The `sub.subscription` JSONB value (originally user-supplied) is cast directly to `webpush.PushSubscription` and passed to `sendNotification`.

**web-push sends HTTPS request to endpoint** (`node_modules/web-push/src/web-push-lib.js:345-354`):
```javascript
const httpsOptions = {};
const urlParts = url.parse(requestDetails.endpoint);
httpsOptions.hostname = urlParts.hostname;
httpsOptions.port = urlParts.port;
httpsOptions.path = urlParts.path;

httpsOptions.headers = requestDetails.headers;
httpsOptions.method = requestDetails.method;

// ...
const pushRequest = https.request(httpsOptions, function(pushResponse) {
```

No hostname/IP validation — the parsed URL components are used directly in `https.request()`.

## Exploit Sketch

1. Choose a valid flight ID from the public flight listing (e.g., flight detail pages on the website).
2. POST to `/api/push/subscribe` with a subscription where `endpoint` points to an internal HTTPS target (e.g., `https://internal-api.corp:8443/health`).
3. The subscription is stored in the database.
4. The notification dispatcher polls every 15 seconds. If new `flightStatusHistory` rows exist for the subscribed flight, `dispatch()` reads the subscription and calls `webpush.sendNotification()`.
5. The server makes an HTTPS POST to the internal target. The VAPID Authorization header and encrypted push payload are included.
6. The attacker cannot directly read the response, but can infer success/failure from error logs or timing side channels.

To ensure the dispatcher processes the subscription, the attacker can wait for naturally-occurring status updates (scrapers run periodically) or, if another vulnerability allows, inject a status update.

## Open Questions

- Whether the internal network has HTTPS services that would be sensitive to blind probing. The HTTPS-only restriction limits the attack surface compared to a full SSRF.
- Whether the attacker can reliably trigger status updates for arbitrary flights to ensure the dispatcher processes their subscription. Without being able to inject status updates, the attacker must wait for scrapers to pick up real-world status changes.
- Whether VAPID headers (which include the VAPID public key) sent to an attacker-controlled endpoint constitute a credential leak. VAPID public keys are not secret, but combined with the VAPID private key (which stays server-side) and the audience, they could be used to forge push notifications.
