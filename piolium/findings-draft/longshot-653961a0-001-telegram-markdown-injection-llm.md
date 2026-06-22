---
id: longshot-653961a0-001
phase: X2
anchor: apps/health-monitor/vitest.config.ts
slug: telegram-markdown-injection-via-unescaped-llm-output
severity: low
confidence: low
---

## Summary

The `buildTelegramMessage` function in the health monitor inserts LLM-generated content (`issue.title`, `issue.explanation`, `llmResult.summary`) into Telegram messages without Markdown escaping, while all other dynamic content in the same function is properly escaped via `escapeMd()`. The LLM's input prompt includes database-sourced text (scraper error messages from `scraper_logs.errorMessage`) that may contain Telegram Markdown special characters. If the LLM reproduces these characters in its output, they will be interpreted as Telegram Markdown formatting directives, potentially breaking message formatting or allowing link injection.

## Location

- `apps/health-monitor/src/index.ts:59-72` — unescaped LLM output in `buildTelegramMessage`
- `apps/health-monitor/src/index.ts:26-28` — `escapeMd` function exists but is not applied to LLM fields
- `apps/health-monitor/src/llm.ts:53-55` — `buildPrompt` includes database samples via `JSON.stringify`
- `apps/health-monitor/src/checks.ts:155-171` — `checkScraperFailureRate` fetches `errorMessage` from `scraper_logs`
- `packages/telegram/src/index.ts:27` — `sendAlert` uses `parse_mode: 'Markdown'` (legacy, not MarkdownV2)
- `packages/database/schema.ts:174` — `errorMessage` is a `text` column with no content restrictions

## Attacker Control

Indirect. An attacker would need to influence the content of `scraper_logs.errorMessage` in the database. Error messages originate from JavaScript `Error` objects when scrapers fail during HTTP requests to external APIs (`apps/guernsey-scraper/src/live.ts:84`, `apps/fr24-scraper/src/scraper.ts:985`). If an attacker can trigger scraper failures that produce predictable error messages containing Telegram Markdown special characters (`*`, `_`, `` ` ``, `[`, `]`, `(`, `)`), those characters would flow:

1. Into `scraper_logs.errorMessage` (database)
2. Into `samples` via `checkScraperFailureRate()` (`apps/health-monitor/src/checks.ts:160,176`)
3. Into the LLM prompt via `buildPrompt()` (`apps/health-monitor/src/llm.ts:53`)
4. Potentially into the LLM's JSON response fields (`title`, `explanation`, `summary`)
5. Into the Telegram message without escaping (`apps/health-monitor/src/index.ts:61-62,70`)

## Trust Boundary Crossed

LLM output (generated from database content that may contain attacker-influenced text) crosses into the Telegram messaging system without sanitization. The `sendAlert` function (`packages/telegram/src/index.ts:27`) applies `parse_mode: 'Markdown'`, meaning Telegram will interpret Markdown syntax in the message body.

## Impact

- **Telegram message formatting corruption**: Unbalanced `*` or `_` characters could break intended bold/italic spans, making alerts harder to read.
- **Link injection**: If the LLM outputs text matching `[label](url)`, Telegram renders it as a clickable link, potentially spoofing the source of the health alert.
- No data exfiltration, code execution, or system compromise is possible through this path.

## Evidence

The `escapeMd` function is defined but only applied to database-derived values, not LLM outputs:

```typescript
// apps/health-monitor/src/index.ts:26-28
function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
```

LLM-generated fields are inserted without escaping:

```typescript
// apps/health-monitor/src/index.ts:59-62
for (const issue of llmResult!.correlated_issues) {
  const sev = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '⚠️' : 'ℹ️';
  const conf = issue.confidence === 'low' ? ' _(low confidence)_' : '';
  lines.push(`${sev} *${issue.title}*${conf}`);       // issue.title NOT escaped
  lines.push(`  ${issue.explanation}`);                 // issue.explanation NOT escaped
}
```

```typescript
// apps/health-monitor/src/index.ts:69-71
if (llmResult?.summary) {
  lines.push(`📋 ${llmResult.summary}`);                // summary NOT escaped
}
```

By contrast, database-derived values in the same function ARE escaped:

```typescript
// apps/health-monitor/src/index.ts:82-83
const label = escapeMd(checkLabel(c));
const val = escapeMd(c.value);
```

The Telegram API uses Markdown parsing:

```typescript
// packages/telegram/src/index.ts:27
body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
```

Database error messages (potential source of special characters) flow into the LLM prompt:

```typescript
// apps/health-monitor/src/llm.ts:52-53
if (c.samples && c.samples.length > 0) {
  prompt += `  Samples: ${JSON.stringify(c.samples.slice(0, 10))}\n`;
}
```

## Exploit Sketch

1. Trigger a scraper failure with a crafted error condition that produces an error message containing Telegram Markdown syntax (e.g., `Failed to parse response [details](https://evil.example.com)` — though actual control over error messages depends on the external API response).
2. Wait for the health monitor to run its next cycle, during which `checkScraperFailureRate()` picks up the failure and includes the error message in samples.
3. The LLM (`analyzeWithLLM`) receives the samples in its prompt. If the LLM reproduces the Markdown syntax in its `title`, `explanation`, or `summary` output fields, those characters reach the Telegram message unescaped.
4. Telegram's Markdown parser interprets the characters, potentially breaking formatting or rendering injected links.

## Open Questions

- Can scraper error messages be reliably influenced to contain specific Markdown payloads? The current scrapers store `err.message` from network/parsing errors, which is normally not attacker-controlled. A separate vulnerability in the scraper's error handling would be needed.
- Does the DeepSeek LLM reliably reproduce Markdown special characters from input samples into its structured JSON output? LLM behavior is probabilistic — this cannot be guaranteed without empirical testing.
- The `escapeMd` function uses MarkdownV2 character set while `sendAlert` uses legacy `Markdown` parse mode. The over-escaping is safe but means some escaped characters would render with visible backslashes. This mismatch should be resolved regardless.
