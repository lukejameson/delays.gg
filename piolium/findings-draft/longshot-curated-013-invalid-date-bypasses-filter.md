---
Phase: 3
Sequence: 013
Slug: invalid-date-bypasses-search-filter
Verdict: VALID
Severity-Original: LOW
Confidence: high
Source-Drafts:
  - piolium/findings-draft/longshot-a1466616-002-invalid-date-bypasses-filter.md
---

## Summary

When an invalid date string is passed as the `date` parameter (e.g., `?date=not-a-date`), the search page skips adding the date range condition to the query but does not return early. The resulting empty `conditions` array causes Drizzle's `and()` to return `undefined`, and `.where(undefined)` removes the WHERE clause entirely, returning unfiltered flight results. This is a logic bug that bypasses all search filtering.

## Affected Files

- `apps/web/src/routes/search/+page.server.ts:26-36` — date parsing silently skips invalid dates
- `apps/web/src/routes/search/+page.server.ts:38` — `and(...conditions)` returns `undefined` when `conditions` is empty
- `node_modules/drizzle-orm/sql/expressions/conditions.js:26-30` — `and()` returns `void 0` for empty input

## Root Cause

The date validation uses `!isNaN(date.getTime())` to conditionally add the filter, but provides no else-branch handling. When an invalid date produces `NaN`, the filter is silently dropped. Combined with Drizzle's `and()` behavior (returns `undefined` for empty args), the WHERE clause is eliminated entirely.

## Attacker Control

The attacker controls the `date` URL query parameter. Any non-parseable value (e.g., `?date=invalid`) triggers the bypass.

## Impact

Visiting `/search?date=invalid` returns the first 100 flights with no filtering. While flights are public data, this violates expected behavior and could aid automated scraping/enumeration. The same bug exists in the debug search mirror at `/api/debug/ui/search`.

## Evidence

**Silently skipped date parsing** (`apps/web/src/routes/search/+page.server.ts:26-36`):
```typescript
if (dateParam) {
  const date = new Date(dateParam);
  if (!isNaN(date.getTime())) {
    // ... add date condition ...
  }
  // No else: invalid date silently ignored
}
```

**Empty conditions → no WHERE** (line 38):
```typescript
.where(conditions.length === 1 ? conditions[0] : and(...conditions))
```

**Drizzle `and()` returns undefined** (`conditions.js:28-30`):
```javascript
if (conditions.length === 0) return void 0;
```

## Exploit Sketch

1. Visit `/search?date=xyz123invalid`
2. Server receives invalid date, skips the date filter, adds no conditions
3. `and(...[])` returns `undefined`, `.where(undefined)` omits WHERE clause
4. All flights returned, ordered by `scheduled_departure`, limited to 100

## Confidence Notes

HIGH confidence — the code path from invalid date to missing WHERE clause is fully traced through source code. Both the SvelteKit handler and the Drizzle ORM behavior are confirmed.
