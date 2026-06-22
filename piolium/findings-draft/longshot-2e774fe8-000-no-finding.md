---
Phase: 2
Sequence: 000
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: NONE
Confidence: high
Anchor: apps/web/src/service-worker.ts
Anchor-Sha8: 2e774fe8
---

## Summary

After rigorous end-to-end review of the service worker (`apps/web/src/service-worker.ts`), all four event handlers (install, activate, fetch, push, notificationclick), and the full push notification pipeline (client subscribe → database → notification-service dispatcher → web-push → service worker → openWindow), no exploitable vulnerability was found. The service worker's sole trusted-data source for `openWindow` is the dispatcher which constructs URLs from database integers (`/flights/<flightId>`). The push notification payload is authenticated with server-side VAPID keys, and no alternate code path exists that could inject arbitrary URLs. The `ASSETS` cache list is generated at build time from SvelteKit. Adjacent endpoints (`/api/push/subscribe`, `/api/push/check/[flightId]`) lack authentication but require an unguessable browser-generated push endpoint token to meaningfully interact with them, and they are outside the anchor file's scope.
