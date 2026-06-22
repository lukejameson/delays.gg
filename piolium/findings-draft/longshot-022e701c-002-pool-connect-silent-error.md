---
Phase: 2
Sequence: 002
Slug: pool-connect-silent-error-swallowing
Verdict: VALID
Severity-Original: LOW
Confidence: high
Anchor: packages/database/index.ts
Anchor-Sha8: 022e701c
---

## Summary

The PostgreSQL connection pool's `connect` event handler in `packages/database/index.ts:84` executes `SET TIME ZONE 'UTC'` on every new connection but silently swallows any errors with `.catch(() => {})`. If this query fails (e.g., due to a transient connection issue, permission restriction, or a PostgreSQL configuration change that blocks `SET` commands), the connection proceeds with the wrong session timezone — and no error is logged, alerted, or surfaced. This silently violates the module's explicit timezone contract (documented in the comments on lines 6-9 and 85-86) and can cause systematic timestamp drift between database writes and reads.

## Location

- `packages/database/index.ts:84-86` — pool connect event handler with silent `.catch(() => {})`

## Attacker Control

No direct attacker control. The vulnerability is an operational defect: error information is permanently lost, making it impossible to detect or diagnose a misconfigured timezone session.

## Trust Boundary Crossed

No trust boundary is crossed. This is a defense-in-depth / observability gap within the database initialization path.

## Impact

In the event that `SET TIME ZONE 'UTC'` fails on a pool connection:

1. **No alerting**: The error is silently discarded, so operators have no way to detect the timezone misconfiguration.
2. **Data corruption risk**: TIMESTAMP WITHOUT TZ values written by the connection would be interpreted in the server's default timezone (not UTC), creating systematic offsets between stored and expected values.
3. **Inconsistent behavior**: Some connections in the pool could be in UTC while others are in a different timezone, depending on which connections succeeded at `SET TIME ZONE`.

The module's own comments acknowledge the criticality of this timezone enforcement:

```typescript
// packages/database/index.ts:6-9
// Force TIMESTAMP WITHOUT TZ (oid 1114) to always be read as UTC regardless of
// the Node.js process timezone. Without this, pg uses the process TZ to interpret
// the raw value, so a dev machine running BST reads the same stored instant as
// 1 hour earlier than a UTC Docker container — causing systematic display drift.
```

And:

```typescript
// packages/database/index.ts:85-86
// Enforce UTC session timezone on every connection so that TIMESTAMP WITHOUT TZ
// values written by pg are stored as UTC wall-clock, consistent with TZ=UTC containers.
```

## Evidence

### Silent error swallowing on pool connect

```typescript
// packages/database/index.ts:84
pool.on('connect', (client) => { client.query("SET TIME ZONE 'UTC'").catch(() => {}); });
```

The `.catch(() => {})` handler is a no-op. The error object (which would contain the PostgreSQL error code, severity, and message) is discarded. Compare with the same module's `getDb()` function, which correctly throws on missing `DATABASE_URL`:

```typescript
// packages/database/index.ts:80-81
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
```

### Contrast with other error handling in the same package

The `singleton.ts` module at least logs errors:

```typescript
// packages/database/singleton.ts:31
console.error(`[singleton] Failed to acquire lock for '${serviceName}':`, err);
```

The pool connect handler provides zero observability — no `console.error`, no metrics counter, no health check signal.

## Exploit Sketch

No active exploit. This is a passive reliability risk:

1. PostgreSQL server is reconfigured (or connection is established in a restricted session) such that `SET TIME ZONE` is rejected.
2. The pool creates new connections that silently operate in the wrong timezone.
3. Application writes timestamps that are offset by the server's default timezone.
4. The bug persists undetected because no error is logged.

## Open Questions

- **Why was `.catch(() => {})` chosen over logging?** Possibly to avoid noisy logs during connection storms, but this trades observability for quietness at the cost of correctness.
- **Does PostgreSQL ever reject `SET TIME ZONE`?** Yes — `SET` requires appropriate privileges, and some connection poolers or managed PostgreSQL services restrict session-level SET commands.
