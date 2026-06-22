---
Phase: 3
Sequence: 001
Slug: secrets-committed-to-git
Verdict: VALID
Severity-Original: CRITICAL
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-d5d04db9-001-hardcoded-debug-token-git.md
  - piolium/findings-draft/longshot-e8be093f-002-hardcoded-secrets-env-committed.md
---

## Summary

The `.env` file containing all application secrets — database credentials (`DATABASE_URL`), the `DEBUG_API_TOKEN`, VAPID private key, session secret, API tokens (FR24, Guernsey, Aurigny OTP), and proxy credentials — is tracked in git (not in `.gitignore`). Additionally, the `DEBUG_API_TOKEN` (`ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1`) is hardcoded verbatim in two scripts (`scripts/airways-cli.sh` and `scripts/airways-cli.py`) also tracked in git. Anyone with repository access can extract all credentials, gaining direct database access, debug API access (unlocking all bypasses in other findings), push notification forging capability, and session hijacking capability.

## Affected Files

- `.env` — committed secrets file containing DATABASE_URL, DEBUG_API_TOKEN, VAPID_PRIVATE_KEY, SESSION_SECRET, FR24_API_TOKEN, GUERNSEY_API_KEY, AURIGNY_OTP2_TOKEN, CF_CLEARANCE_COOKIE, proxy credentials
- `.gitignore` — missing `.env` entry
- `scripts/airways-cli.sh:6` — hardcoded `AUTH="Authorization: Bearer ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1"`
- `scripts/airways-cli.py:9` — same token hardcoded
- `packages/database/schema.ts` — all schema tables become accessible via exposed DATABASE_URL
- `apps/web/src/hooks.server.ts:7-13` — auth gate that validates the exposed DEBUG_API_TOKEN

## Root Cause

Failure to exclude `.env` from version control (`.gitignore` does not list `.env`) and accidental inclusion of live secrets in scripts tracked in git. Both are cases of secrets management failure — credentials intended to be runtime-only environment variables are permanently baked into the git history.

## Attacker Control

No active exploitation required. Anyone with read access to the git repository (public or internal) can `cat .env` or `git show HEAD:.env` to extract all credentials, or read `scripts/airways-cli.sh:6`.

## Impact

- **Full database compromise**: `DATABASE_URL=postgres://manga_user:manga_password@localhost:5432/airwaysgg` grants direct PostgreSQL access to all tables including `users` (password hashes) and `sessions` (session tokens)
- **Debug API access**: The exposed `DEBUG_API_TOKEN` unlocks all debug endpoints, including the raw SQL endpoint at `/api/debug/sql`, enabling all bypasses documented in curated finding 003
- **Push notification hijacking**: `VAPID_PRIVATE_KEY=ciNzpkSvohYPLQTWQaHDxOB5OyRfqXU-2wLH5vCOILQ` allows forging push notifications to all subscribed browsers
- **Session forgery**: `SESSION_SECRET=airways-gg-local-dev-secret-change-in-prod` (weak, predictable) enables session cookie forgery
- **API key compromise**: FR24 API token, Guernsey API key, Aurigny OTP2 token, Cloudflare clearance cookie all exposed
- **Blast radius**: Credentials in git history are effectively permanent — even if removed from HEAD, they remain accessible via `git log -p`

## Evidence

**`.env` tracked by git** (not in `.gitignore`):
- `git ls-files .env` returns `.env`
- `.gitignore:1-5` — only contains `node_modules/`, `alpha_testing/`, `orignal_scraper/`

**Exposed credentials** from `.env`:
- `DATABASE_URL=postgres://manga_user:manga_password@localhost:5432/airwaysgg`
- `DEBUG_API_TOKEN=ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1`
- `VAPID_PRIVATE_KEY=ciNzpkSvohYPLQTWQaHDxOB5OyRfqXU-2wLH5vCOILQ`
- `SESSION_SECRET=airways-gg-local-dev-secret-change-in-prod`

**Hardcoded token in scripts**:
- `scripts/airways-cli.sh:6`: `AUTH="Authorization: Bearer ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1"`
- `scripts/airways-cli.py:9`: `AUTH = "ac504f9dc9c07ad7d3fb53ecefe0ccecd2beab6922d0bb6eb3bc1898a8919da1"`

**Auth gate validates this exact token** (`apps/web/src/hooks.server.ts:10`):
```typescript
if (!validateDebugToken(auth, env.DEBUG_API_TOKEN)) {
```

**Token validation is exact string match** (`apps/web/src/lib/server/debug-helpers.ts:103`):
```typescript
return authHeader === `Bearer ${expectedToken}`;
```

## Exploit Sketch

1. Clone or access the airways.gg git repository
2. Extract all secrets from `.env` (working tree or git history)
3. Connect directly to PostgreSQL using `DATABASE_URL` credentials — full database read/write
4. Use `DEBUG_API_TOKEN` to access `/api/debug/sql` and exploit all bypasses
5. Use `VAPID_PRIVATE_KEY` to send malicious push notifications
6. Use `SESSION_SECRET` to forge session cookies

## Confidence Notes

HIGH confidence — both source drafts independently confirmed the same secrets from different anchors (`scripts/debug-weather-join.ts` and `packages/database/schema.ts`). The `.env` file was directly read and confirmed committed. The token in the scripts is visible verbatim with no ambiguity. The only open question is whether these credentials are production or development — but several values (API tokens, Cloudflare cookies) appear to be non-placeholder live values.
