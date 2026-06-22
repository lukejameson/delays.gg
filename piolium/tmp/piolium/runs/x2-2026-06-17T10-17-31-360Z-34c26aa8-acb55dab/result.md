---

**Longshot anchor 34c26aa8 (`packages/common/src/flights.ts`) complete. Drafts: 1.**

**Summary of analysis:**

The anchor file `packages/common/src/flights.ts` exports three primary symbols — `TERMINAL_STATUSES`, `isTerminalStatus`, and `getActiveFlightsConditions` — all of which are effectively dead code:

- **`getActiveFlightsConditions`** — zero consumers anywhere in the repository (confirmed via exhaustive grep; only referenced in the file itself and the barrel re-export at `packages/common/src/index.ts:17`).
- **`isTerminalStatus`** and **`TERMINAL_STATUSES`** — imported exactly once by `apps/fr24-scraper/src/index.ts:1` but neither symbol is ever referenced beyond that import line (dead imports).
- All actual flight-status logic uses the separate `isTerminalStatus` implementation in `packages/database/statusPriority.ts:29`, consumed via `@airways/database` by the web app (`+page.server.ts:37`), the Guernsey scraper (`live.ts:1`), and the FR24 scraper (`scraper.ts:4`).
- No client-side Svelte code imports `@airways/common` at all.
- The `additionalTerminalStatuses` parameter in `getActiveFlightsConditions` is a theoretical footgun (could be a SQL injection vector if the returned array were ever interpolated into raw SQL) but no caller exists to exploit it.

Verdict: **NO-FINDING** — pure dead utility code with no active I/O, no attacker-controlled data flow, and no exploitation path.
