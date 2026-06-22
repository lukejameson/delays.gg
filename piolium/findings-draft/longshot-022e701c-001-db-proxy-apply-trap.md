---
Phase: 2
Sequence: 001
Slug: db-proxy-apply-trap
Verdict: VALID
Severity-Original: LOW
Confidence: high
Anchor: packages/database/index.ts
Anchor-Sha8: 022e701c
---

## Summary

The `db` export in `packages/database/index.ts` uses a JavaScript `Proxy` with both `get` and `apply` traps. The `apply` trap forwards function-call invocations of `db` to the underlying Drizzle ORM client by calling it as a function: `(getDb() as unknown as (...a: unknown[]) => unknown)(...args)`. The Drizzle ORM `node-postgres` client (v0.45.1) is not callable as a plain function — it has no `[[Call]]` internal method. If any code inadvertently invokes `db(...)` or `db.call(...)`, the `apply` trap fires and throws an unhandled `TypeError`, crashing the server process.

## Location

- `packages/database/index.ts:93-99` — Proxy definition with `apply` trap
- `packages/database/index.ts:79-92` — `getDb()` returns a Drizzle client that is not callable

## Attacker Control

An attacker cannot easily trigger this directly. However, if any dynamically-dispatched code path attempts to treat `db` as callable (e.g., through a generic middleware that invokes all exported functions, or through a dependency that probes objects for callability), the server would crash. The `apply` trap makes the Proxy appear callable to `typeof db === 'function'` checks (`typeof` on a Proxy with `apply` returns `"function"`).

## Trust Boundary Crossed

No trust boundary is crossed — this is a latent operational defect within the database module itself. The Proxy exposes a call signature that doesn't exist on the underlying object, creating a false-positive callability contract.

## Impact

If triggered (e.g., by a refactor that treats `db` as callable, or by a library that introspects `typeof x === 'function'` and calls the result), the server process crashes with an unhandled TypeError. This is a denial-of-service vector that could be triggered accidentally by code changes.

## Evidence

### Proxy definition with apply trap

```typescript
// packages/database/index.ts:93-99
export const db: DbClient = new Proxy({} as DbClient, {
  get(_t, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
  apply(_t, _this, args) {
    return (getDb() as unknown as (...a: unknown[]) => unknown)(...args);
  },
});
```

### getDb() returns a non-callable Drizzle client

```typescript
// packages/database/index.ts:88
_db = drizzle(pool, { schema });
return _db;
```

The `drizzle(pool, { schema })` call returns a `PostgresJsDatabase<typeof schema>` — an object with query methods but no `[[Call]]` internal method. Casting it `as unknown as (...a: unknown[]) => unknown` and invoking it would throw a TypeError at runtime.

### Proxy typeof returns "function" due to apply trap

Per the ECMAScript specification, a Proxy with an `apply` trap causes `typeof proxy` to return `"function"` (ES2025 §10.5.14). This means `typeof db === 'function'` evaluates to `true`, misleading any code that checks for callability before invoking.

## Exploit Sketch

No practical exploit exists through the current code paths — no code in the repository calls `db(...)`. However:

1. A library or middleware that iterates exported members and invokes any that are `typeof x === 'function'` would crash.
2. A misinformed developer who sees `typeof db === 'function'` (via the Proxy trick) and calls `db('SELECT 1')` directly would crash the process.
3. The `apply` trap appears to be dead code — it was likely included as a defensive measure but achieves the opposite effect by advertising false callability.

## Open Questions

- **Why does the `apply` trap exist?** The `DbClient` type is `ReturnType<typeof drizzle<typeof schema>>`, which should never be callable. The `apply` trap appears to be copy-pasted boilerplate from a generic Proxy pattern.
- **Is there a Drizzle version where the client IS callable?** Drizzle ORM's HTTP-based drivers (e.g., `@vercel/postgres`, `neon-http`) do support a callable client pattern (e.g., `await db.query.flights.findMany()`), but `node-postgres` does not expose a top-level call signature in v0.45.1.
