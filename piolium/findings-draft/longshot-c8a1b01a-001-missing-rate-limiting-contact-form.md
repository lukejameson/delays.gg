---
Phase: 2
Sequence: 001
Slug: missing-rate-limiting-contact-form
Verdict: VALID
Severity-Original: LOW
Confidence: high
Anchor: apps/web/src/routes/contact/+page.server.ts
Anchor-Sha8: c8a1b01a
---

## Summary

The contact form at `/contact` has no rate limiting, IP-based throttling, or per-session submission caps. Each form submission triggers a server-side `fetch()` to Formspree (`PUBLIC_FORMSPREE_URL`). An unauthenticated attacker can flood this endpoint with thousands of requests, exhausting the Formspree quota (e.g., 50 free-tier submissions/month), consuming server outbound HTTP resources (sockets, memory, CPU), and enabling email-spam through the platform's own contact channel.

## Location

- `apps/web/src/routes/contact/+page.server.ts:33` — unprotected `fetch()` to external URL inside form action
- `apps/web/src/routes/contact/+page.server.ts:11-44` — entire `actions.default` handler, no rate-limiting guard
- `apps/web/src/hooks.server.ts:1-42` — global server hook, no rate-limiting middleware
- `apps/web/svelte.config.js:1-17` — no `csrf` config override, but no rate-limit plugin either

## Attacker Control

- **Entry point**: `POST /contact` (SvelteKit form action)
- **Attacker-supplied fields**: `name`, `email`, `type`, `message` — all submitted as `multipart/form-data` or `application/x-www-form-urlencoded`
- **Authentication required**: None (public route)
- The attacker can script this with standard HTTP tooling (curl, Python requests, etc.) — no CSRF token or origin bypass is needed because SvelteKit 2's default origin check is satisfied by setting a matching `Origin` header (or absent for same-origin requests from modern browsers, though a scripted attack can set any Origin).

## Trust Boundary Crossed

- **Boundary**: Unauthenticated internet user → Server-side outbound HTTP (Formspree API)
- The attacker crosses from the public internet into the server's outbound-request capacity and the configured Formspree endpoint's submission quota.

## Impact

- **Resource exhaustion**: Each request spawns a server-side `fetch()` to Formspree. No limit on concurrent or total submissions means an attacker can exhaust file descriptors, event-loop capacity, and memory on the Node.js server.
- **Quota exhaustion**: Formspree free tier has strict submission limits (typically 50/month). A short burst of automated submissions permanently disables the contact form for legitimate users until the next billing cycle.
- **Email spam**: Each successful submission triggers an email to `contact@airways.gg` (the Formspree-configured recipient). Automated flooding can be used to harass the operator or bury a legitimate report.

## Evidence

**No rate limiting in the form action** — `apps/web/src/routes/contact/+page.server.ts:11-44`:

```typescript
export const actions: Actions = {
  default: async ({ request }) => {
    const formspreeUrl = env.PUBLIC_FORMSPREE_URL;
    if (!formspreeUrl) {
      return fail(500, { error: 'Contact form is not configured.' });
    }

    const data = await request.formData();
    const name = data.get('name')?.toString().trim();
    const email = data.get('email')?.toString().trim();
    const type = data.get('type')?.toString();
    const message = data.get('message')?.toString().trim();

    if (!name || !email || !type || !message) {
      return fail(400, { error: 'All fields are required.' });
    }

    const validTypes = ['general', 'feature', 'bug'];
    if (!validTypes.includes(type)) {
      return fail(400, { error: 'Invalid enquiry type.' });
    }

    const res = await fetch(formspreeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name, email, _replyto: email, type, message }),
    });

    if (!res.ok) {
      return fail(500, { error: 'Failed to send message. Please try again.' });
    }

    return { success: true };
  },
};
```

No pre-action guard checking IP frequency, session counters, or any throttle mechanism exists anywhere in this handler.

**No rate limiting globally** — verified via grep across the entire `apps/web/src` directory:
- `grep -ri 'rate\|throttle\|ratelimit' apps/web/src/` returns zero results
- `apps/web/src/hooks.server.ts` contains only debug-API auth gating and cache-control logic — no rate-limit middleware

**Formspree fetch is the only action in the app** — `grep 'export const actions' apps/web/src` returns only this one file. This is the sole POST form-action entry point and it lacks any abuse protection.

## Exploit Sketch

1. Attacker crafts a script that sends 1000+ POST requests to `https://airways.gg/contact` with form-encoded `name`, `email`, `type`, and `message` fields.
2. Each request passes field validation (valid `type` from the allowlist, all fields non-empty) and triggers a server-side `fetch()` to Formspree.
3. After ~50 submissions (free tier) or ~1000 (paid tier), Formspree begins rejecting requests. The contact form returns "Failed to send message" to all users — including legitimate ones — until the quota resets.
4. Concurrently, the server's outbound HTTP connection pool and event loop are stressed by the flood of pending `fetch()` promises.

## Open Questions

- **Formspree plan**: Unknown which Formspree tier is in use. Free tier (50/month) makes this easily DoS-able in seconds. Paid tiers raise the ceiling but don't eliminate the vector.
- **Reverse-proxy protections**: If Cloudflare or Traefik provides IP-based rate limiting in front of the app, the attack surface is reduced but not eliminated (distributed attacks, IPv6 ranges).
- **BODY_SIZE_LIMIT**: The Docker Compose sets `BODY_SIZE_LIMIT=10M`, but this is a request-body cap, not a rate limiter. It does not mitigate this issue.
