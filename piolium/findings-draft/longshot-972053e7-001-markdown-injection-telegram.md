---
Phase: 2
Sequence: 001
Slug: markdown-injection-via-llm-output-in-telegram
Verdict: VALID
Severity-Original: LOW
Confidence: high
Anchor: apps/health-monitor/src/checks.ts
Anchor-Sha8: 972053e7
---

## Summary

The `buildTelegramMessage` function in `apps/health-monitor/src/index.ts` fails to escape Markdown-special characters in LLM-generated fields (`issue.title`, `issue.explanation`, `llmResult.summary`) before sending them to Telegram with `parse_mode: 'Markdown'` enabled. The health monitor's own check data is properly escaped via `escapeMd()`, but the LLM response fields are inserted raw into the message template. If the LLM produces output containing `*`, `_`, `` ` ``, or `[text](url)` patterns, they will be interpreted as Telegram Markdown formatting, potentially altering message rendering or enabling social engineering via injected links.

## Location

- `apps/health-monitor/src/index.ts:72-74` — `issue.title`, `issue.explanation`, and `llmResult.summary` inserted without escaping
- `apps/health-monitor/src/index.ts:15-17` — `escapeMd()` defined (MarkdownV2-style escaping) but not applied to LLM output fields
- `packages/telegram/src/index.ts:22` — `sendAlert()` uses `parse_mode: 'Markdown'` (legacy Markdown mode)
- `apps/health-monitor/src/llm.ts:131-145` — LLM response parsed as JSON, fields returned directly
- `apps/health-monitor/src/checks.ts:141-170` — `checkScraperFailureRate()` includes `errorMessage` from database in samples that flow into LLM prompt (connection to prompt injection surface)

## Attacker Control

An attacker would need to influence the LLM's output to include malicious Markdown. The LLM prompt is constructed from check results (`apps/health-monitor/src/llm.ts:buildPrompt`, line 72-82), which include database-derived data such as scraper log `errorMessage` fields (`apps/health-monitor/src/checks.ts:160-161`). These error messages are populated by scrapers (`apps/guernsey-scraper/src/live.ts:84-90`, `apps/guernsey-scraper/src/scraper.ts:896`, `apps/fr24-scraper/src/scraper.ts:993`) from JavaScript `Error` objects during scraping operations. While direct control over error messages is limited, the prompt injection surface exists as a defense-in-depth gap.

## Trust Boundary Crossed

This is a secondary trust boundary crossing: **LLM API response → Telegram Markdown rendering context**. The LLM response is treated as trusted content (no output encoding), but the response originates from a third-party API whose input includes database content that traces back to external scraped data.

## Impact

- **Message formatting corruption**: `*` or `_` in LLM fields can break or alter Telegram message rendering, making alerts harder to read.
- **Phishing/social engineering**: If an attacker achieves prompt injection (e.g., via scraped data influencing error messages), the LLM could be manipulated to output `[legitimate text](https://evil.com)` in `issue.explanation` or `llmResult.summary`, rendering as a clickable link in the Telegram monitoring channel.
- **Confusion/spoofing**: An attacker could inject Markdown that mimics system messages, hiding or falsifying health status information.

## Evidence

**Unescaped LLM fields in message construction** (`apps/health-monitor/src/index.ts:68-78`):
```typescript
if (hasLLM) {
    lines.push('🧠 *LLM Cross-Signal Analysis*');
    for (const issue of llmResult!.correlated_issues) {
      const sev = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '⚠️' : 'ℹ️';
      const conf = issue.confidence === 'low' ? ' _(low confidence)_' : '';
      lines.push(`${sev} *${issue.title}*${conf}`);       // ← title NOT escaped inside *...*
      lines.push(`  ${issue.explanation}`);                 // ← explanation NOT escaped at all
    }
    lines.push('');
  }

  // Summary
  if (llmResult?.summary) {
    lines.push(`📋 ${llmResult.summary}`);                  // ← summary NOT escaped at all
    lines.push('');
  }
```

**Contrast with properly escaped check data** (`apps/health-monitor/src/index.ts:86-93`):
```typescript
for (const c of catFailed) {
    const label = escapeMd(checkLabel(c));   // ← properly escaped
    const val = escapeMd(c.value);            // ← properly escaped
    const thr = escapeMd(c.threshold);        // ← properly escaped
    lines.push(`  🔴 ${label}: ${val} (threshold: ${thr})`);
```

**escapeMd function** (`apps/health-monitor/src/index.ts:15-17`):
```typescript
function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
```
This function is defined and used for check data but never applied to `issue.title`, `issue.explanation`, or `llmResult.summary`.

**Telegram sendAlert uses Markdown parsing** (`packages/telegram/src/index.ts:22`):
```typescript
body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
```

## Exploit Sketch

1. An attacker finds a way to influence data that enters the LLM prompt. The most viable path is through scraper `errorMessage` values in `scraperLogs` table, which are included in `checkScraperFailureRate()` samples (only when rate exceeds threshold — 4+ failures in 6h).
2. The attacker's crafted content flows into the LLM prompt via `buildPrompt()` (`apps/health-monitor/src/llm.ts:72-78`).
3. The LLM is tricked into returning a `correlated_issue` with `title: "normal text*_"` and `explanation: "[click here](https://evil.com)"` or a `summary` containing Markdown formatting characters.
4. `buildTelegramMessage()` inserts these values directly into the Telegram message body without escaping.
5. Telegram renders the injected Markdown, potentially displaying a phishing link or corrupting the message format.

## Open Questions

- **Practical prompt injection feasibility**: Can an attacker reliably influence `scraperLogs.errorMessage` to contain prompt injection payloads? Error messages come from JavaScript runtime errors (e.g., network failures, JSON parse errors, PostgreSQL constraint violations). JSON parse errors could include a few bytes from the response body, and PostgreSQL unique constraint violations include key values. Neither provides reliable, high-bandwidth injection.
- **LLM robustness against injection**: The system prompt instructs the LLM to "Be conservative" and "Only flag correlations you are reasonably confident about." The DeepSeek model may be resistant to prompt injection that attempts to produce arbitrary Markdown in structured JSON output fields.
- **Telegram MarkdownV2 vs legacy**: `sendAlert` uses `parse_mode: 'Markdown'` (legacy) while `escapeMd` targets MarkdownV2's escape set. While this mismatch causes unnecessary escaping of some characters, the legacu Markdown special characters (`_`, `*`, `` ` ``, `[`) are all in the V2 set, so the escaping would work if applied to LLM fields.
