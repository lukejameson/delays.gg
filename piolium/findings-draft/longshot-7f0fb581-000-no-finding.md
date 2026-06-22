---
Phase: 2
Verdict: NO-FINDING
Anchor-Sha8: 7f0fb581
Anchor: packages/common/src/types.ts
---
## Summary

Pure TypeScript type/interface definition file with no I/O, no deserialization, no authentication logic, and no runtime behavior beyond simple Error subclass constructors. Of the 30+ exports, only `AirborneEntry` and `TimerState` are actually imported by consumers (`apps/adsb-service/src/index.ts:1`, `apps/fr24-scraper/src/index.ts:1`, `packages/database/scheduler.ts:11`); both are inert data shapes used for local state tracking (a Map of flight poll-miss counts and a collection of timer handles, respectively). The `PushNotification.data: Record<string, unknown>` field and `ServiceError.details?: unknown` field appear concerning on the surface but are never consumed anywhere in the codebase — the notification service builds its own payload inline. No untrusted input flows through any type defined in this file to a sensitive sink. Reviewed all 9 consumer files that import from `@airways/common`; none expose a vulnerability anchored on this file.
