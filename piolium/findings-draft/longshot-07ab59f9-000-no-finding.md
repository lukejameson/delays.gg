---
Phase: 2
Sequence: 000
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: NONE
Confidence: high
Anchor: apps/notification-service/src/index.ts
Anchor-Sha8: 07ab59f9
---

## Summary

Thin entry-point file that loads environment variables via `loadEnv` (`packages/common/src/env.ts:36`), validates VAPID keys are present, and runs a `setTimeout`-based polling loop calling `dispatch()` from `apps/notification-service/src/dispatcher.ts`. The file itself has no independent vulnerability — it delegates all work to `dispatcher.ts`. The SSRF vulnerability in the dispatcher (user-supplied push subscription endpoints reaching `webpush.sendNotification()`) is already documented by the sibling anchor `longshot-a7b59fb0-001-ssrf-push-subscription-endpoint.md` (anchor: `apps/notification-service/src/dispatcher.ts`). The unauthenticated subscribe endpoint is covered by `longshot-d9f2f2b5-001-unauthenticated-push-manipulation.md`. No new trust boundaries, entry points, or sinks are introduced by this file. Reviewed all imports (`@airways/common`, `@airways/telegram`, `./dispatcher`) and found no additional attack surface.
