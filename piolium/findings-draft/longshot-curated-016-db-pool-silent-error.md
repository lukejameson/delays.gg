---
Phase: 3
Sequence: 016
Slug: db-pool-connect-silent-error
Verdict: VALID
Severity-Original: LOW
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-022e701c-002-pool-connect-silent-error.md
---

## Summary

The PostgreSQL connection pool's `connect` event handler executes `SET TIME ZONE 'UTC'` on every new connection but silently swallows any errors with `.catch(() => {})`. If this query fails (due to permission restrictions, transient issues, or PostgreSQL configuration), the connection proceeds with the wrong session timezone — with no error logged, alerted, or surfaced. This silently violates the module's explicit timezone contract and can cause systematic timestamp drift.

## Affected Files

- `packages/database/index.ts:84` — pool connect handler with silent `.catch(() => {})`

## Root Cause

The `.catch(() => {})` error handler is a no-op — the error object (PostgreSQL error code, severity, message) is permanently discarded. This trades observability for quietness, violating the module's own documented requirement that "TIMESTAMP WITHOUT TZ values written by pg are stored as UTC wall-clock."

## Attacker Control

No direct attacker control. This is an operational reliability defect — a passive risk that would manifest during abnormal database conditions.

## Impact

If `SET TIME ZONE 'UTC'` fails on a pool connection:
- **No alerting**: Operators cannot detect the timezone misconfiguration
- **Data corruption risk**: TIMESTAMP WITHOUT TZ values written with wrong timezone offset
- **Inconsistent behavior**: Some pool connections in UTC, others in server-default timezone

## Evidence

**Silent error swallowing** (`packages/database/index.ts:84`):
```typescript
pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'UTC'").catch(() => {});
});
```

**Documented timezone requirement** (`packages/database/index.ts:6-9`):
```typescript
// Force TIMESTAMP WITHOUT TZ (oid 1114) to always be read as UTC regardless of
// the Node.js process timezone. Without this, pg uses the process TZ to interpret
// the raw value, so a dev machine running BST reads the same stored instant as
// 1 hour earlier than a UTC Docker container — causing systematic display drift.
```

## Exploit Sketch

No active exploit — passive reliability risk. Manifests during abnormal database conditions.

## Confidence Notes

HIGH confidence — the `.catch(() => {})` pattern is directly visible. The module's own comments acknowledge the criticality of timezone enforcement, creating a self-documented gap between intent and implementation.
