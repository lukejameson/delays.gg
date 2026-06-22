---
id: longshot-0c60f88c-000
phase: X2
anchor: packages/common/src/index.ts
slug: no-finding
severity: none
confidence: high
---

## Summary

Pure barrel (re-export) file with no executable logic. All six re-exported modules (`env.ts`, `timezone.ts`, `flights.ts`, `circuit-breaker.ts`, `config.ts`, `types.ts`) were read in full and their callers traced across the repository. None contain exploitable vulnerabilities:

- **env.ts** (`loadEnv`/`findEnvFile`): All 7 callers across backend services pass `__dirname` as `startDir`; no attacker-controlled path input reaches `resolve()`/`dotenv.config()`.
- **timezone.ts**: Pure `Date`/`Intl.DateTimeFormat` arithmetic with zero I/O and zero user input.
- **flights.ts**: `getActiveFlightsConditions` is dead code (zero imports outside the barrel). `isTerminalStatus`/`TERMINAL_STATUSES` are used only for in-memory string comparisons; actual SQL queries use Drizzle ORM parameterized builders in `packages/database/scheduler.ts`.
- **circuit-breaker.ts**: In-memory state machine; `parseInt` on env vars defaults to safe fallback values (5, 60000) when env is unset or NaN.
- **config.ts**: `ENV_VARS` exports env var name strings (e.g., `'VAPID_PRIVATE_KEY'`), not actual secret values. No runtime exposure path exists — the web app never imports `@airways/common`.
- **types.ts**: Zero-runtime-impact TypeScript type/interface definitions and error classes.

No attacker-controlled data flow reaches any sink through the barrel or its re-exported modules.
