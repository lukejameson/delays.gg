---
Phase: 2
Sequence: 000
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: NONE
Confidence: high
Anchor: apps/web/src/routes/stats/+page.server.ts
Anchor-Sha8: 860ee574
---

## Summary

After rigorous review of the anchor file (`apps/web/src/routes/stats/+page.server.ts`) and all imported dependencies (`queries.ts`, `types.ts`, `stores.ts`, `transforms.ts`, `+page.svelte`, `hooks.server.ts`, `+layout.server.ts`, `$lib/server/db.ts`, `packages/database/index.ts`), no exploitable security vulnerability was found.

All user-supplied URL query parameters (`range`, `dateFrom`, `dateTo`, `airline`, `route`, `direction`, `dow`, `season`, `month`, `year`, `threshold`) are either validated against allowlists or passed through drizzle-orm's `sql` tagged template literal, which produces parameterized PostgreSQL queries — preventing SQL injection. The stats page is intentionally public (no auth gate exists in hooks or layouts for this route). Svelte's template auto-escaping and absence of `{@html}` prevent XSS. No file operations, command execution, SSRF, deserialization, or hardcoded secrets are present in the data flow.

Noted but non-exploitable: the `+page.server.ts` constructs `airlineFilter`, `dateFilter`, `routeMinFilter`, `routeFilter`, and `directionFilter` SQL fragments (lines 71–110) that are never used (dead code from a refactor); the `resolveAirlineCode` mapping for LM/SI codeshares is likewise unused in the refactored path. The actual filter construction is handled safely in `queries.ts`.
