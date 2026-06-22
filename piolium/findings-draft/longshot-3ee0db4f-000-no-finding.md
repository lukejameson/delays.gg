---
id: longshot-3ee0db4f-000
phase: X2
anchor: apps/web/src/lib/delays.ts
slug: no-finding
severity: none
confidence: high
---

## Summary

`apps/web/src/lib/delays.ts` is an unused utility file containing five pure functions (`calculateDelayMinutes`, `formatDelay`, `formatEarly`, `isDelayed`, `isEarly`). All functions perform only arithmetic and date-parsing operations on primitive inputs (strings, Dates, numbers). No function in this file is imported or called anywhere in the repository. The file contains no I/O, no network access, no database queries, no filesystem operations, no authentication/authorization logic, no `eval()`/`new Function()` calls, and no prototype pollution vectors. No security vulnerability is present.
