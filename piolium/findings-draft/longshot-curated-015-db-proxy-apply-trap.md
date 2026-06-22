---
Phase: 3
Sequence: 015
Slug: db-proxy-apply-trap-crash
Verdict: VALID
Severity-Original: LOW
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-022e701c-001-db-proxy-apply-trap.md
---

## Summary

The `db` export in `packages/database/index.ts` uses a JavaScript `Proxy` with an `apply` trap that forwards function-call invocations to the underlying Drizzle ORM client: `(getDb() as unknown as (...a: unknown[]) => unknown)(...args)`. However, the Drizzle `node-postgres` client is not callable — it has no `[[Call]]` internal method. If any code inadvertently invokes `db(...)`, the `apply` trap throws an unhandled `TypeError`, crashing the server process. Additionally, the `apply` trap causes `typeof db === 'function'` to return `true`, advertising false callability.

## Affected Files

- `packages/database/index.ts:93-99` — Proxy definition with `apply` trap

## Root Cause

The Proxy's `apply` trap appears to be copy-pasted boilerplate from a generic Proxy pattern. It casts the Drizzle client `as unknown as (...a: unknown[]) => unknown` and attempts to invoke it as a function, but the underlying object is not callable.

## Attacker Control

No direct attacker control. This is a latent operational defect — the `apply` trap is currently dead code (no caller invokes `db(...)`) but creates a crash risk for future refactors.

## Impact

If triggered (by a refactor, library, or middleware that probes for callability), the server crashes with unhandled TypeError. The `typeof db === 'function'` (caused by the Proxy's `apply` trap per ES2025 §10.5.14) misleads any code that checks callability before invoking.

## Evidence

**Proxy with apply trap** (`packages/database/index.ts:93-99`):
```typescript
export const db: DbClient = new Proxy({} as DbClient, {
  get(_t, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
  apply(_t, _this, args) {
    return (getDb() as unknown as (...a: unknown[]) => unknown)(...args);
  },
});
```

**getDb() returns non-callable Drizzle client** (`packages/database/index.ts:88`):
```typescript
_db = drizzle(pool, { schema });
```

## Exploit Sketch

No practical exploit through current code paths. Risk is limited to accidental triggering during refactoring.

## Confidence Notes

HIGH confidence — the Proxy definition and `apply` trap are directly visible. The non-callable nature of the Drizzle client is confirmed. Currently dead code but represents a latent crash risk.
