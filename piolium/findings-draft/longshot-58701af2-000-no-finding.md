---
id: longshot-58701af2-000
phase: X2
anchor: packages/common/src/config.ts
slug: no-finding
severity: none
confidence: high
---

## Summary
Pure constants/config file with no I/O or user-input handling. The exported `ENV_VARS` object is dead code (zero imports across the repo — all services access `process.env` directly). `mins()`/`secs()` are simple arithmetic helpers used only with operator-controlled environment variables. No exploitable chain found after reviewing all callers and the web app's Vite bundling configuration.
