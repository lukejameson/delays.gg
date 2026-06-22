---
Phase: 2
Sequence: 001
Slug: markdown-injection-via-llm-output-in-telegram
Verdict: VALID
Severity-Original: LOW
Confidence: high
Anchor: apps/health-monitor/src/index.ts
Anchor-Sha8: 70820091
---

## Summary

The `buildTelegramMessage` function in `apps/health-monitor/src/index.ts` fails to escape Telegram Markdown special characters in LLM-generated fields (`issue.title`, `issue.explanation`, `llmResult.summary`) before sending them to Telegram with `parse_mode: 'Markdown'` enabled. The health monitor's own check data is properly escaped via `escapeMd()`, but LLM response fields are inserted raw into the message template. If the DeepSeek LLM produces output containing `*`, `_`, `` ` ``, or `[text](url)` patterns, those characters will be interpreted as Telegram Markdown formatting, causing cosmetic message corruption. In the worst case, a crafted LLM response could inject clickable links into operator-facing alerts.

## Location

- `apps/health-monitor/src/index.ts:68-78` — `buildTelegramMessage()` inserts LLM fields into Telegram message without `escapeMd()`
- `apps/health-monitor/src/index.ts:15-17` — `escapeMd()` defined but applied only to check result data, not LLM data
- `apps/health-monitor/src/llm.ts:128-177` — `analyzeWithLLM()` fetches and JSON-parses DeepSeek response, returns `LLMResponse` with `correlated_issues` and `summary` fields
- `packages/telegram/src/index.ts:20-21` — `sendAlert()` sends message with `parse_mode: 'Markdown'` enabled, applying Telegram Markdown parsing

## Attacker Control

The LLM (DeepSeek API) is an external third-party system whose responses are not fully deterministic. An attacker who can influence the LLM output — either through:

1. **Prompt injection via database content**: Scraper error messages (`scraper_logs.errorMessage`), flight data, push subscription endpoints, and other database fields flow into the LLM prompt via `buildPrompt()` (`apps/health-monitor/src/llm.ts:56-99`). If an attacker can poison any of these database fields (e.g., by manipulating scraper inputs or exploiting another vulnerability), they could inject instructions that cause the LLM to produce Markdown-formatted output.

2. **LLM supply chain / model behavior**: The LLM may independently produce Markdown special characters in its explanations or titles (e.g., wrapping terms in `*emphasis*` or `` `code` ``), which is common behavior for instruction-tuned models.

## Trust Boundary Crossed

The trust boundary is between the **LLM API response** (external, untrusted system) and the **Telegram bot message output** (trusted operator communication channel). The LLM response is JSON-parsed but its string fields are treated as trusted safe content and interpolated directly into a Markdown-formatted message without sanitization.

## Impact

- **Cosmetic corruption**: LLM output containing `*` or `_` characters breaks bold/italic formatting in the Telegram alert, potentially making critical health information harder to parse.
- **Link injection**: An LLM response containing `[click here](https://malicious.example)` would render as a clickable link in the Telegram message, enabling phishing attacks against operators.
- **Operational confusion**: Malformed messages could obscure genuine infrastructure issues during incident response.

## Evidence

**buildTelegramMessage** (`apps/health-monitor/src/index.ts:68-78`) — LLM fields inserted without escaping:

```typescript
if (hasLLM) {
    lines.push('🧠 *LLM Cross-Signal Analysis*');
    for (const issue of llmResult!.correlated_issues) {
      const sev = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '⚠️' : 'ℹ️';
      const conf = issue.confidence === 'low' ? ' _(low confidence)_' : '';
      lines.push(`${sev} *${issue.title}*${conf}`);          // ← issue.title NOT escaped
      lines.push(`  ${issue.explanation}`);                    // ← issue.explanation NOT escaped
    }
    lines.push('');
  }

  // Summary
  if (llmResult?.summary) {
    lines.push(`📋 ${llmResult.summary}`);                     // ← summary NOT escaped
    lines.push('');
  }
```

**Contrast with check result data** (`apps/health-monitor/src/index.ts:88-96`) — properly escaped:

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

**Telegram message sent with Markdown parsing** (`packages/telegram/src/index.ts:20-21`):

```typescript
await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
```

## Exploit Sketch

1. An attacker induces a scraper to log a crafted error message containing prompt injection payload (e.g., via a malicious API response to the FR24 scraper or Guernsey scraper).
2. The error message is stored in `scraper_logs.errorMessage` in the database.
3. On the next Tier 2 cycle, `checkScraperFailureRate()` retrieves the error message as a sample.
4. `buildPrompt()` serializes the check results including the injected text into the LLM prompt.
5. The DeepSeek LLM, influenced by the injected text, produces a response where `issue.explanation` contains `[EVACUATE SERVER](https://evil.com)` or similar.
6. `buildTelegramMessage()` inserts this raw text into the Telegram message.
7. The Telegram bot sends the message with `parse_mode: 'Markdown'`, rendering the injected link as a clickable URL visible to operators.

## Open Questions

- **MarkdownV2 vs legacy Markdown**: `sendAlert` uses `parse_mode: 'Markdown'` (Telegram legacy) while `escapeMd` targets MarkdownV2's escape set. The two modes have slightly different special character sets. This discrepancy should be resolved regardless of this finding.
- **Exploitability via LLM prompt injection**: The chain requires an attacker to influence LLM output via database content poisoning. Without confirming whether scrapers accept attacker-controlled inputs that flow to `errorMessage`, the full exploit chain is theoretical but the defensive gap (unescaped LLM output in Telegram messages) is independently valid.
- **Note**: This finding may overlap with `longshot-972053e7-001` (from the `checks.ts` anchor) which identifies the same vulnerable code in `index.ts`. The Phase 3 aggregator should deduplicate.
