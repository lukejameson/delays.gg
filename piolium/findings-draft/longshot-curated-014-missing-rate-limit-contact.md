---
Phase: 3
Sequence: 014
Slug: missing-rate-limiting-contact-form
Verdict: VALID
Severity-Original: LOW
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-c8a1b01a-001-missing-rate-limiting-contact-form.md
---

## Summary

The contact form at `/contact` has no rate limiting, IP-based throttling, or per-session submission caps. Each form submission triggers a server-side `fetch()` to Formspree. An unauthenticated attacker can flood this endpoint, exhausting the Formspree quota, consuming server outbound HTTP resources, and enabling email spam through the platform's own contact channel.

## Affected Files

- `apps/web/src/routes/contact/+page.server.ts:11-44` — form action with no rate limiting
- `apps/web/src/hooks.server.ts:1-42` — global hooks, no rate-limit middleware

## Root Cause

The form action handler performs input validation (required fields, type allowlist) but has no abuse-prevention mechanism. No request frequency tracking, IP-based throttling, session counters, or CAPTCHA. No rate limiting exists anywhere in the application (`grep -ri 'rate\|throttle\|ratelimit' apps/web/src/` returns zero results).

## Attacker Control

Unauthenticated POST to `/contact` with form-encoded `name`, `email`, `type` (from allowlist), and `message`.

## Impact

- **Formspree quota exhaustion**: Free tier (50/month) exhaustible in seconds
- **Server resource consumption**: Each request spawns outbound `fetch()`, straining event loop and connection pool
- **Email spam**: Flood the configured `contact@airways.gg` recipient

## Evidence

**Form action — no rate limiting** (`apps/web/src/routes/contact/+page.server.ts:11-44`):
```typescript
export const actions: Actions = {
  default: async ({ request }) => {
    // ... input validation only ...
    const res = await fetch(formspreeUrl, { ... });
    if (!res.ok) return fail(500, { error: '...' });
    return { success: true };
  },
};
```
No pre-action guard, no IP tracking, no throttle mechanism.

**No global rate limiting** — confirmed via grep.

## Exploit Sketch

1. Script 1000+ POST requests to `/contact` with valid form data
2. Each triggers server-side `fetch()` to Formspree
3. After ~50 submissions (free tier), Formspree rejects — contact form breaks for all users

## Confidence Notes

HIGH confidence — the absence of rate limiting is unambiguous. The form action was fully read and contains only input validation. Globally, zero rate-limiting mechanisms exist in the web app.
