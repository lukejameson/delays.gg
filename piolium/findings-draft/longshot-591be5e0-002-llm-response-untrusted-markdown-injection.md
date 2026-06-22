---
id: longshot-591be5e0-002
phase: X2
anchor: apps/health-monitor/src/llm.ts
slug: llm-response-untrusted-markdown-injection
severity: low
confidence: high
---

## Summary

LLM-generated response fields (`correlated_issues[].title`, `correlated_issues[].explanation`, and `summary`) are inserted into Telegram messages without Markdown escaping, while all other user-facing values (check names, values, thresholds) are properly escaped via `escapeMd()`. An attacker who successfully prompts the LLM to output Markdown control characters could break Telegram message formatting, but cannot achieve code execution or data exfiltration through this vector alone.

## Location

- `apps/health-monitor/src/index.ts:78-85` — LLM response fields used without `escapeMd()`
- `apps/health-monitor/src/index.ts:88-89` — `summary` also unescaped
- `apps/health-monitor/src/index.ts:15-17` — `escapeMd` function exists but is not applied to LLM fields
- `apps/health-monitor/src/index.ts:96-100` — check names/values ARE properly escaped with `escapeMd()`
- `packages/telegram/src/index.ts:12-23` — `sendAlert` sends with `parse_mode: 'Markdown'`
- `apps/health-monitor/src/llm.ts:43-57` — `LLMResponse` type definition for the untrusted fields

## Attacker Control

Indirect: an attacker must first achieve prompt injection (see finding 001) to influence the LLM's output. Once the LLM output contains attacker-influenced `title`, `explanation`, or `summary` text with Markdown special characters (`_*[]()~`>#+-=|{}.!`), those characters are passed unescaped into Telegram's Markdown parser.

## Trust Boundary Crossed

AI model output (untrusted) → Telegram message markup parser. The LLM output is treated as trusted content suitable for direct embedding in Markdown, though it originates from a model that can be influenced by external input.

## Impact

- **Message formatting corruption**: Markdown control characters in LLM fields can break bold/italic formatting, create unintended code blocks, or truncate messages at certain characters
- **Cosmetic only**: In Telegram `parse_mode: 'Markdown'` (v1), there is no mechanism to inject hyperlinks with custom text, execute scripts, or exfiltrate data. The impact is limited to visual degradation of the alert message.

## Evidence

**1. escapeMd defined and used for check data but not LLM data:**

`apps/health-monitor/src/index.ts:15-17`:
```typescript
function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
```

`apps/health-monitor/src/index.ts:96-100` (check values ARE escaped):
```typescript
for (const c of catFailed) {
  const label = escapeMd(checkLabel(c));
  const val = escapeMd(c.value);
  const thr = escapeMd(c.threshold);
  lines.push(`  🔴 ${label}: ${val} (threshold: ${thr})`);
```

**2. LLM response fields NOT escaped:**

`apps/health-monitor/src/index.ts:78-85`:
```typescript
for (const issue of llmResult!.correlated_issues) {
  const sev = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '⚠️' : 'ℹ️';
  const conf = issue.confidence === 'low' ? ' _(low confidence)_' : '';
  lines.push(`${sev} *${issue.title}*${conf}`);
  lines.push(`  ${issue.explanation}`);
}
```

`apps/health-monitor/src/index.ts:88-89`:
```typescript
if (llmResult?.summary) {
  lines.push(`📋 ${llmResult.summary}`);
```

**3. Telegram API uses Markdown parse mode:**

`packages/telegram/src/index.ts:12-23`:
```typescript
export async function sendAlert(
  service: string,
  level: 'critical' | 'warning',
  message: string,
  error?: unknown,
): Promise<void> {
  ...
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  }).catch(() => {});
```

## Exploit Sketch

1. Achieve prompt injection via the push subscription vector (finding 001), crafting a payload that causes the DeepSeek LLM to include Markdown special characters in the `title`, `explanation`, or `summary` fields.

2. For example, inject text that makes the LLM output a title like `Alert:_Critical_Failure` (with unescaped underscores). In Telegram Markdown, underscores trigger italic formatting, causing the bold-wrapped title `*Alert:_Critical_Failure*` to render incorrectly.

3. The resulting Telegram message has garbled formatting, potentially obscuring important alert information from operators.

## Open Questions

- **Practical exploitability**: This requires combining with prompt injection (finding 001). The Markdown escaping gap alone is not exploitable without first manipulating the LLM.
- **Telegram Markdown v1 vs v2**: The code uses `parse_mode: 'Markdown'` (legacy v1). If migrated to `MarkdownV2`, the escaping requirements change and additional characters (like `(` `)` `.` `!`) could cause different formatting issues.
