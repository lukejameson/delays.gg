---
Phase: 2
Sequence: 001
Slug: sharp-edge-telegram-markdown-parsing
Verdict: VALID
Severity-Original: LOW
Confidence: high
Anchor: packages/telegram/src/index.ts
Anchor-Sha8: 0ce8fc90
---

## Summary

The `sendAlert` function unconditionally enables Telegram's Markdown parsing (`parse_mode: 'Markdown'`) for every message it sends, yet provides **no built-in escaping, sanitization, or documentation** requiring callers to escape their input. This is a sharp-edge API design — callers must know to escape Markdown-special characters (`*`, `_`, `` ` ``, `[`) before passing data to `sendAlert`. Callers that fail to escape create Markdown injection vulnerabilities where attacker-controlled content can corrupt message formatting or inject clickable phishing links into operator-facing Telegram alerts. The health monitor caller (`apps/health-monitor/src/index.ts`) already exhibits this bug (documented in `longshot-972053e7-001` and `longshot-70820091-001`). Additionally, the debounce cache (`sent` Map) grows unboundedly over the lifetime of the process, as entries are never evicted, creating a slow memory leak in long-running services.

## Location

- `packages/telegram/src/index.ts:21` — `parse_mode: 'Markdown'` hardcoded with no escaping API
- `packages/telegram/src/index.ts:2` — Module-level `sent` Map that never evicts entries
- `packages/telegram/src/index.ts:17` — `message` interpolated directly without escaping
- `packages/telegram/src/index.ts:18` — `error` converted via `String(error)` and interpolated directly without escaping
- `apps/health-monitor/src/index.ts:68-78` — Example misusing caller: LLM output fields not escaped (see `longshot-972053e7-001`, `longshot-70820091-001` for full documentation)
- `apps/health-monitor/src/index.ts:15-17` — `escapeMd()` exists in caller but is NOT provided by the telegram package itself

## Attacker Control

This finding is about the API design, not a specific injection path. The attacker's control depends on the caller:

- **Health monitor (existing findings)**: Attacker influences LLM output via prompt injection through database content (scraper error messages). The LLM's response fields (`issue.title`, `issue.explanation`, `llmResult.summary`) are passed to `sendAlert` without escaping, and Telegram renders Markdown in them.
- **General pattern**: Any caller that passes externally-derived data (API responses, database content, error messages from network operations) into the `message` or `error` parameters without first escaping Markdown characters creates an injection surface. Because `sendAlert` provides no escaping and no guardrails, developers are likely to repeat this mistake.

## Trust Boundary Crossed

**Caller data → Telegram Markdown rendering engine**: When a caller passes unescaped externally-derived content through `sendAlert`, that content crosses from the application's internal data flow into Telegram's Markdown parsing context. The `parse_mode: 'Markdown'` setting grants the external content the ability to control formatting, create links, and alter the visual structure of messages in the operator's Telegram client.

## Impact

- **Message corruption**: Unescaped `*`, `_`, or `` ` `` characters break bold/italic/code formatting in operator-facing alerts, potentially making critical information unreadable during incidents.
- **Link injection**: Unescaped `[text](url)` patterns render as clickable links, enabling phishing or social engineering against operators who trust the monitoring channel.
- **Silent propagation**: Because the API provides no guardrails or warnings, new callers are likely to repeat the same escaping mistake. The existing health monitor bug was introduced and persisted despite an `escapeMd()` helper being available in the caller's own file.
- **Memory leak**: The unbounded `sent` Map (module-level debounce cache) stores every unique `service:message_prefix` key forever. In a long-running service that generates varied error messages (e.g., FR24 scraper with Puppeteer errors containing timestamps or dynamic content), this Map grows without bound.

## Evidence

**Unconditional Markdown parsing with no escaping** (`packages/telegram/src/index.ts:15-22`):

```typescript
const text = `${icon} *airways.gg — ${service}*\n${message}${errorSnippet}`;

await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
}).catch(() => {});
```

The `message` parameter (line 17) and `String(error)` (line 18) are interpolated into `text` without any escaping, then sent with `parse_mode: 'Markdown'` (line 21). There is no exported escaping utility, no documentation comment warning about Markdown, and no option to disable Markdown parsing.

**Unbounded debounce cache** (`packages/telegram/src/index.ts:2`):

```typescript
const sent = new Map<string, number>();
```

Entries are added (line 14: `sent.set(key, now)`) but never removed. The Map is checked on every call (line 12) but only the value is compared; stale entries persist forever.

**Contrast: Caller's escape utility exists but isn't part of the package** (`apps/health-monitor/src/index.ts:15-17`):

```typescript
function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
```

This utility is re-implemented in the caller and applied to some but not all message fields. It is NOT provided by `@airways/telegram`, forcing every caller to discover and re-implement escaping.

**Existing caller vulnerability** (`apps/health-monitor/src/index.ts:70-78`):

```typescript
lines.push(`${sev} *${issue.title}*${conf}`);       // title NOT escaped
lines.push(`  ${issue.explanation}`);                 // explanation NOT escaped
// ...
if (llmResult?.summary) {
    lines.push(`📋 ${llmResult.summary}`);             // summary NOT escaped
}
```

These LLM-generated fields flow into `sendAlert` without escaping. This is already documented in `longshot-972053e7-001` and `longshot-70820091-001`.

## Exploit Sketch

The design flaw enables exploitation in any caller that passes unescaped data:

1. A developer writes a new service that calls `sendAlert('my-service', 'warning', `Something wrong with ${userInput}`, err)`.
2. Because the `sendAlert` function has no documented escaping requirement and provides no `escapeMd()` export, the developer does not escape `userInput`.
3. If `userInput` contains `[click here](https://evil.com)`, Telegram renders it as a clickable link in the operator's alert channel.
4. The operator, trusting the internal monitoring channel, clicks the link.

For the already-documented health monitor chain:
1. Attacker poisons scraper data → LLM prompt → LLM outputs Markdown → `buildTelegramMessage()` passes it unescaped → `sendAlert` sends with Markdown parsing → Telegram renders injected formatting/links.

## Open Questions

- **Should `parse_mode` be opt-in?** The safest fix is to remove `parse_mode: 'Markdown'` by default and let callers opt in with explicit escaping (or switch to `parse_mode: 'HTML'` with proper HTML entity encoding). This would eliminate the entire class of Markdown injection bugs.
- **Should the package export `escapeMd` / `escapeMarkdownV2`?** Even if Markdown parsing remains the default, providing an exported escaping utility would reduce the likelihood of callers forgetting to escape.
- **Is the `sent` Map memory leak practically exploitable?** In normal operation, the number of unique keys is limited by the variety of error messages. In pathological cases (e.g., an attacker triggering many unique errors), it could contribute to memory exhaustion. A periodic cleanup or LRU eviction would eliminate this concern.
- **Overlap with existing findings**: `longshot-972053e7-001` and `longshot-70820091-001` document the specific health monitor caller vulnerability. This finding documents the root cause in the anchor file itself. The Phase 3 aggregator should deduplicate appropriately.
