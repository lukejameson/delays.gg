---
id: longshot-34c26aa8-000
phase: X2
anchor: packages/common/src/flights.ts
slug: no-finding
severity: none
confidence: high
---

## Summary

All three primary exports from this file are dead code. `getActiveFlightsConditions` has zero consumers anywhere in the repository. `isTerminalStatus` and `TERMINAL_STATUSES` are imported only by `apps/fr24-scraper/src/index.ts:1` but never referenced beyond the import statement (dead imports). All actual flight-status logic in the codebase uses the separate `isTerminalStatus` implementation in `packages/database/statusPriority.ts:29`, which is consumed by the web app (`+page.server.ts:37`) and both scraper services via the `@airways/database` barrel. The file contains no I/O, no database access, no command execution, no deserialization, and no network operations. No attacker-controlled data enters or passes through any of its functions in any active code path.
