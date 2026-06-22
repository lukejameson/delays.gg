---
Phase: 3
Sequence: 011
Slug: llm-output-markdown-injection-telegram
Verdict: VALID
Severity-Original: LOW
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-591be5e0-002-llm-response-untrusted-markdown-injection.md
  - piolium/findings-draft/longshot-653961a0-001-telegram-markdown-injection-llm.md
  - piolium/findings-draft/longshot-70820091-001-markdown-injection-telegram.md
  - piolium/findings-draft/longshot-972053e7-001-markdown-injection-telegram.md
---

## Summary

The `buildTelegramMessage` function in the health monitor inserts LLM-generated fields (`issue.title`, `issue.explanation`, `llmResult.summary`) into Telegram messages without Markdown escaping, while all other dynamic content (check names, values, thresholds) is properly escaped via `escapeMd()`. The `sendAlert` function in `packages/telegram` sends messages with `parse_mode: 'Markdown'` enabled, so any Markdown special characters in LLM output fields will be interpreted as Telegram formatting. This can cause message corruption or, if the LLM is manipulated to output `[text](url)` patterns, clickable link injection in operator-facing alerts.

## Affected Files

- `apps/health-monitor/src/index.ts:68-78` — `buildTelegramMessage()` inserts LLM fields without `escapeMd()`
- `apps/health-monitor/src/index.ts:15-17` — `escapeMd()` defined but not applied to LLM output
- `apps/health-monitor/src/index.ts:88-96` — check data correctly escaped (contrast)
- `apps/health-monitor/src/llm.ts:128-177` — `analyzeWithLLM()` returns `LLMResponse` with unsanitized string fields
- `packages/telegram/src/index.ts:20-21` — `sendAlert()` sends with `parse_mode: 'Markdown'`

## Root Cause

Missing output encoding: LLM API responses are treated as trusted content despite originating from an external third-party system (DeepSeek) whose input includes database content that traces back to external scraper data. The `escapeMd()` function exists and is correctly applied to database-derived check data in the same function, but is not applied to LLM response fields.

## Attacker Control

Indirect — requires first achieving prompt injection (curated finding 006) to influence the LLM to produce Markdown special characters in its output. Alternatively, the LLM may independently produce Markdown formatting (bold, italic) in explanations, which is common behavior for instruction-tuned models.

## Impact

- **Message formatting corruption**: `*` or `_` in LLM fields can break Telegram bold/italic rendering
- **Link injection**: LLM output containing `[text](https://evil.com)` renders as clickable link
- **Operational confusion**: Malformed messages during incident response could obscure critical information
- No data exfiltration, code execution, or system compromise possible through this path alone

## Evidence

**LLM fields NOT escaped** (`apps/health-monitor/src/index.ts:68-78`):
```typescript
lines.push(`${sev} *${issue.title}*${conf}`);       // ← title NOT escaped
lines.push(`  ${issue.explanation}`);                 // ← explanation NOT escaped
lines.push(`📋 ${llmResult.summary}`);                // ← summary NOT escaped
```

**Check data IS escaped** (contrast in same function, lines 88-96):
```typescript
const label = escapeMd(checkLabel(c));   // ← properly escaped
const val = escapeMd(c.value);            // ← properly escaped
const thr = escapeMd(c.threshold);        // ← properly escaped
```

**escapeMd function** (`apps/health-monitor/src/index.ts:15-17`):
```typescript
function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
```

**Telegram uses Markdown parsing** (`packages/telegram/src/index.ts:20-21`):
```typescript
body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
```

## Exploit Sketch

1. Achieve prompt injection via push subscription flightCode (curated finding 006)
2. Cause LLM to output `[EVACUATE SERVER](https://evil.com)` in `issue.explanation`
3. `buildTelegramMessage()` inserts the raw text into the Telegram message
4. Telegram renders the injected link as clickable in the operator's alert channel

## Confidence Notes

HIGH confidence — the missing `escapeMd()` calls on LLM fields are directly visible in source code, with the correct escaping pattern visible immediately below for check data. The Markdown injection path is independently valid as a defense-in-depth gap regardless of prompt injection feasibility. Note: 4 source drafts from 4 different anchors all identified the same escaping gap in the same function, confirming it from multiple perspectives. Draft `653961a0-001` (anchor: `vitest.config.ts`) had LOW confidence but identified the same code — merged for completeness.
