---
id: longshot-a1466616-002
phase: X2
anchor: apps/web/src/routes/search/+page.server.ts
slug: invalid-date-bypasses-filter
severity: low
confidence: high
---

## Summary

When an invalid date string is passed as the `date` parameter (e.g. `?date=not-a-date`), the code skips adding the date range condition to the query but does not return early. The resulting empty `conditions` array causes Drizzle's `and()` to return `undefined`, and `.where(undefined)` removes the WHERE clause entirely, returning unfiltered flight results. This is a logic bug that bypasses all search filtering — not a security vulnerability on its own (flights are public data), but it violates the expected behavior that at least one filter should be active when search parameters are provided.

## Location

- `apps/web/src/routes/search/+page.server.ts:26-36` — date parsing and condition construction
- `apps/web/src/routes/search/+page.server.ts:38` — `and(...conditions)` returns `undefined` when `conditions` is empty
- `node_modules/drizzle-orm/sql/expressions/conditions.js:26-30` — `and()` returns `void 0` for empty input
- `node_modules/drizzle-orm/pg-core/query-builders/select.js:582` — `.where(undefined)` sets `this.config.where = undefined`, omitting the WHERE clause

## Attacker Control

The attacker controls the `date` URL query parameter. At `+page.server.ts:27-28`:

```typescript
const date = new Date(dateParam);
if (!isNaN(date.getTime())) {
```

When `dateParam` is an invalid date string like `"not-a-date"`, `new Date("not-a-date")` produces an invalid Date object where `.getTime()` returns `NaN`. The `!isNaN(NaN)` check evaluates to `false`, so the date range condition is never added to `conditions`.

The initial guard at line 9 only checks for empty strings:
```typescript
if (!query && !dateParam && !fromParam && !toParam) {
```

Since `"not-a-date"` is a non-empty (truthy) string, the guard passes and execution continues into the try block.

## Trust Boundary Crossed

User-controlled URL parameter → server-side query construction logic. The trust boundary crossed here is between expected behavior (filters should be applied) and actual behavior (filters are silently dropped).

## Impact

An attacker accessing `/search?date=invalid` receives the first 100 flights ordered by `scheduled_departure` with no filtering applied. While this does not expose sensitive data (flights are public), it:

1. Violates the principle of least surprise — a malformed date should produce an error or empty results, not silently return all data
2. Could be combined with automated scraping to enumerate all flights more efficiently than through the intended search interface
3. Exposes internal database IDs (`flight.id` as a serial primary key) in the unfiltered results, which could aid in enumeration attacks against other endpoints

## Evidence

**Entry point** (`apps/web/src/routes/search/+page.server.ts:26-36`):
```typescript
if (dateParam) {
  const date = new Date(dateParam);
  if (!isNaN(date.getTime())) {
    date.setHours(0, 0, 0, 0);
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    conditions.push(
      and(
        gte(flights.scheduledDeparture, date),
        lte(flights.scheduledDeparture, nextDay),
      )!,
    );
  }
}
```

**Empty conditions → `and()` returns `undefined`** (`+page.server.ts:38`):
```typescript
.where(conditions.length === 1 ? conditions[0] : and(...conditions))
```

When `conditions` is `[]`, `conditions.length` is `0`, so `and(...[])` is called.

**Drizzle `and()` with empty args returns `undefined`** (`node_modules/drizzle-orm/sql/expressions/conditions.js:28-30`):
```javascript
function and(...unfilteredConditions) {
  const conditions = unfilteredConditions.filter((c) => c !== void 0);
  if (conditions.length === 0) {
    return void 0;
  }
```

**Drizzle `.where(undefined)` drops the WHERE clause** (`node_modules/drizzle-orm/pg-core/query-builders/select.js:582`):
```javascript
where(where) {
    // ... function-type where handling ...
    this.config.where = where;
    return this;
}
```

Setting `this.config.where = undefined` causes the query builder to emit `SELECT * FROM flights ORDER BY scheduled_departure LIMIT 100` with no WHERE clause.

## Exploit Sketch

1. Visit `/search?date=xyz123invalid`
2. The server receives `dateParam = "xyz123invalid"`
3. Initial guard passes (`"xyz123invalid"` is truthy, so `!dateParam` is `false`)
4. `new Date("xyz123invalid")` produces Invalid Date
5. `isNaN(date.getTime())` is `true`, so date condition is skipped
6. `query`, `fromParam`, `toParam` are all empty strings → no conditions added
7. `conditions` is `[]`, `and()` returns `undefined`
8. `.where(undefined)` removes the WHERE clause
9. All flights returned (first 100 by `scheduled_departure` order)

## Open Questions

- Whether this behavior was intentional (treating invalid dates as "no date filter") or an oversight
- The same bug exists in the debug API mirror at `apps/web/src/routes/api/debug/ui/search/+server.ts:37-47`, though that endpoint requires authentication
