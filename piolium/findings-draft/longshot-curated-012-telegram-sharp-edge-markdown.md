---
Phase: 3
Sequence: 012
Slug: telegram-package-sharp-edge-markdown
Verdict: VALID
Severity-Original: LOW
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-0ce8fc90-001-sharp-edge-telegram-markdown.md
---

## Summary

The `sendAlert` function in `packages/telegram/src/index.ts` unconditionally enables Telegram's Markdown parsing (`parse_mode: 'Markdown'`) for every message, yet provides no built-in escaping utility, no opt-out mechanism, and no documentation warning callers to escape their input. This is a "sharp edge" API design — callers must independently discover and implement Markdown escaping, and failure to do so creates Markdown injection vulnerabilities (as seen in curated finding 011). Additionally, the module-level `sent` debounce Map grows unboundedly, creating a slow memory leak.

## Affected Files

- `packages/telegram/src/index.ts:15-22` — `sendAlert()` hardcodes `parse_mode: 'Markdown'` with no escaping API
- `packages/telegram/src/index.ts:2` — `sent` Map never evicts entries (memory leak)

## Root Cause

The `sendAlert` function makes an opinionated choice (Markdown parsing enabled) without providing the complementary safety mechanism (an exported `escapeMd()` function). The debounce cache (`sent` Map) has write-only lifecycle — entries are added but never removed.

## Attacker Control

Indirect — this is an API design finding, not a specific injection path. The impact depends on callers. The existing health monitor caller exhibits the exact bug this design enables (curated finding 011).

## Impact

- Every new caller of `sendAlert` is at risk of repeating the Markdown injection bug
- The package provides no `escapeMd()` export, forcing callers to re-implement escaping
- The `sent` Map memory leak can contribute to memory exhaustion in long-running services with varied error messages
- Message corruption and link injection in Telegram alerts (via callers that fail to escape)

## Evidence

**Unconditional Markdown with no escaping** (`packages/telegram/src/index.ts:15-22`):
```typescript
const text = `${icon} *airways.gg — ${service}*\n${message}${errorSnippet}`;
await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
}).catch(() => {});
```

**No exported escape utility** — grep for `export.*escape` in `packages/telegram/` returns nothing.

**Unbounded debounce cache** (`packages/telegram/src/index.ts:2`):
```typescript
const sent = new Map<string, number>();
```
Entries are added (`sent.set(key, now)`) but never deleted.

**Caller must re-implement escaping** (`apps/health-monitor/src/index.ts:15-17`):
```typescript
function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
```

## Exploit Sketch

Not directly exploitable — this is a design finding. The impact manifests through callers that fail to escape, as documented in curated finding 011.

## Confidence Notes

HIGH confidence — the API design gap is directly visible in source code. The absence of an exported escape utility and the unbounded Map are unambiguous. The finding is corroborated by the existing caller vulnerability (curated finding 011) which is a direct consequence of this API design.
