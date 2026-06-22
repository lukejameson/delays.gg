---
Phase: 2
Sequence: 001
Slug: timing-side-channel-validate-debug-token
Verdict: VALID
Severity-Original: LOW
Confidence: low
Anchor: apps/web/src/lib/server/debug-helpers.ts
Anchor-Sha8: 9f8a89bc
---

## Summary

The `validateDebugToken` function compares the `Authorization` header against the expected Bearer token using JavaScript's `===` operator, which performs a non-constant-time string comparison. In V8, `===` for strings uses `memcmp`, which short-circuits on the first mismatched byte. An attacker who can measure response times with sufficient precision could theoretically brute-force the `DEBUG_API_TOKEN` character-by-character, bypassing the sole authentication gate for all `/api/debug/*` endpoints. In practice, network jitter makes this extremely difficult, but the violation of constant-time comparison is a real defensive gap.

## Location

- `apps/web/src/lib/server/debug-helpers.ts:98-104` — `validateDebugToken` with non-constant-time comparison
- `apps/web/src/hooks.server.ts:8-10` — caller that gates `/api/debug/*` behind this function

## Attacker Control

The attacker controls the `Authorization` HTTP header, which flows through:

1. `apps/web/src/hooks.server.ts:9`: `const auth = event.request.headers.get('authorization')`
2. `apps/web/src/hooks.server.ts:10`: `validateDebugToken(auth, env.DEBUG_API_TOKEN)`
3. `apps/web/src/lib/server/debug-helpers.ts:103`: `return authHeader === \`Bearer ${expectedToken}\``

The attacker's `Authorization` header value is compared byte-by-byte against the expected token. A mismatch at position N causes the comparison to return after ~N byte comparisons rather than after the full length.

## Trust Boundary Crossed

The `validateDebugToken` function is the sole authentication mechanism for all `/api/debug/*` endpoints. The design intent is that only callers who possess the `DEBUG_API_TOKEN` can access debug functionality. A timing oracle on the token comparison leaks information about the secret token value through a side-channel, partially undermining this authentication boundary.

## Impact

If an attacker can measure response times with microsecond precision:
- **Token brute-forcing**: The attacker can determine the token character-by-character by measuring which candidate produces a slightly longer response time (one more matching character before rejection).
- **Authentication bypass**: Once the token is discovered, the attacker gains full access to all debug endpoints, including the raw SQL execution endpoint (`POST /api/debug/sql`) which exposes the entire database.

In practice, exploitation over a network is extremely difficult due to:
- Nanosecond-scale timing differences per byte
- Network jitter in the millisecond range
- The need for thousands of requests per character

However, the vulnerability is real: the code pattern violates the cryptographic principle that authentication token comparisons must be constant-time.

## Evidence

### 1. Non-constant-time comparison in `validateDebugToken` (debug-helpers.ts:98-104)

```typescript
// apps/web/src/lib/server/debug-helpers.ts:98-104
export function validateDebugToken(
  authHeader: string | null,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken || !authHeader) return false;
  return authHeader === `Bearer ${expectedToken}`;
}
```

The `===` operator on strings in V8:
1. First compares string lengths (O(1)) — if lengths differ, returns immediately
2. Then compares byte-by-byte using `memcmp` (O(n) worst case, short-circuits on first mismatch)

This means:
- A completely wrong first character: comparison fails after ~1 byte (very fast)
- A correct first character but wrong second: comparison fails after ~2 bytes (slightly slower)
- A fully correct token: comparison succeeds after full length (slowest)

### 2. No constant-time comparison utility exists in the codebase

A grep for `timingSafeEqual`, `constant-time`, `timing-safe`, or `crypto.timing` across `apps/web/src` returns zero results. The codebase has no mechanism for constant-time secret comparison.

### 3. The auth gate is the only protection for all debug endpoints (hooks.server.ts:7-12)

```typescript
// apps/web/src/hooks.server.ts:7-12
if (event.url.pathname.startsWith('/api/debug/')) {
    const auth = event.request.headers.get('authorization');
    if (!validateDebugToken(auth, env.DEBUG_API_TOKEN)) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }
}
```

All `/api/debug/*` routes (including the raw SQL execution endpoint at `/api/debug/sql`) depend solely on `validateDebugToken` for access control. No secondary authentication mechanism exists.

### 4. All failure paths return identical responses

```typescript
// apps/web/src/lib/debug-auth.test.ts:12-16 (early returns)
expect(validateDebugToken('Bearer wrong-token', token)).toBe(false);
expect(validateDebugToken(null, token)).toBe(false);
expect(validateDebugToken('', token)).toBe(false);
```

All failure modes return `false` with identical `{ error: 'Unauthorized' }` JSON responses (issued by `hooks.server.ts:11`). There is no content-based oracle — only timing differences exist.

## Exploit Sketch

1. The attacker knows the expected token format is `Bearer <secret>` (from the `debug-auth.test.ts` tests and standard HTTP convention).
2. The attacker sends requests with `Authorization: Bearer <candidate>` headers, varying the first unknown character.
3. For each candidate, the attacker measures the time from request to the 401 response.
4. The candidate whose first character matches the real token causes `memcmp` to compare one additional byte before failing, resulting in a statistically measurable (but extremely small) timing delta.
5. After collecting thousands of samples per candidate, the attacker uses statistical analysis (e.g., Student's t-test) to identify the correct character.
6. The attacker repeats for each subsequent character position until the full token is recovered.
7. With the token, the attacker accesses any debug endpoint.

**Practical difficulty**: Network jitter (~1-10ms) vastly exceeds the per-byte comparison time (~1-10ns). The attacker would need millions of requests per character to achieve statistical significance.

## Open Questions

1. **Network proximity**: If the attacker is on the same network (or localhost), jitter is reduced and the attack becomes more feasible. Can the debug API be accessed from localhost without the token?
2. **Request rate limiting**: Is there any rate limiting on `/api/debug/*` endpoints? If so, it would further impair timing attacks but would also be a defense-in-depth measure worth confirming.
3. **Node.js `crypto.timingSafeEqual` availability**: Node.js has built-in `crypto.timingSafeEqual` since v6.6.0. Using it instead of `===` would eliminate this side-channel entirely with negligible performance impact.
4. **Alternative side-channels**: Could CPU cache timing, branch prediction state, or other microarchitectural side-channels leak token information more effectively than direct response timing? These are typically only exploitable by co-located (same-machine) attackers.
