---
Phase: 3
Sequence: 017
Slug: timing-side-channel-debug-token
Verdict: VALID
Severity-Original: LOW
Confidence: low
Source-Drafts:
  - piolium/findings-draft/longshot-9f8a89bc-001-timing-side-channel-debug-token.md
---

## Summary

The `validateDebugToken` function compares the `Authorization` header against the expected Bearer token using JavaScript's `===` operator, which performs a non-constant-time string comparison. In V8, `===` for strings uses `memcmp`, which short-circuits on the first mismatched byte. An attacker who can measure response times with sufficient precision could theoretically brute-force the `DEBUG_API_TOKEN` character-by-character. Network jitter makes this extremely difficult in practice, but the code pattern violates the cryptographic principle that authentication token comparisons must be constant-time.

## Affected Files

- `apps/web/src/lib/server/debug-helpers.ts:98-104` — `validateDebugToken()` with non-constant-time comparison
- `apps/web/src/hooks.server.ts:8-10` — caller that gates `/api/debug/*` behind this function

## Root Cause

JavaScript's `===` operator on strings uses `memcmp` which short-circuits on first mismatch. No constant-time comparison utility (e.g., Node.js `crypto.timingSafeEqual`) is used.

## Attacker Control

The attacker controls the `Authorization` HTTP header. Response times vary by a few nanoseconds per matching byte — network jitter (~1-10ms) vastly exceeds this signal, requiring millions of requests per character for statistical significance.

## Impact

Theoretical token brute-forcing with nanosecond-scale timing differences. In practice, exploitation over a network is extremely difficult. However, the defense-in-depth gap is real: if an attacker achieves local network access (same machine/VPC), the attack becomes more feasible.

## Evidence

**Non-constant-time comparison** (`debug-helpers.ts:103`):
```typescript
return authHeader === `Bearer ${expectedToken}`;
```

**No `crypto.timingSafeEqual` usage** — grep for `timingSafeEqual` returns zero results.

**Node.js has built-in constant-time comparison since v6.6.0** — fix is trivial.

## Exploit Sketch

1. Attacker sends requests with `Authorization: Bearer <candidate>` headers, varying one character
2. Measures response times with microsecond precision
3. Correct character causes one additional byte comparison (~1-10ns delta)
4. After millions of samples, statistical analysis identifies correct character
5. Repeats for each position until full token recovered

## Confidence Notes

LOW confidence — the vulnerability exists in theory (non-constant-time comparison is confirmed) but practical exploitation over a network is extremely difficult due to nanosecond vs millisecond-scale timing differences. The low confidence reflects practical exploitability, not the presence of the code defect. Mitigation is trivial (use `crypto.timingSafeEqual`).
