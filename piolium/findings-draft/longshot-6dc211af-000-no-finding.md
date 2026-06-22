---
id: longshot-6dc211af-000
phase: X2
anchor: apps/web/src/lib/statusConfig.ts
slug: no-finding
severity: none
confidence: high
---

## Summary

`statusConfig.ts` is a pure utility module that maps arbitrary flight status strings to a fixed set of color "tone" categories (`green | yellow | red | blue | purple | orange | gray`) using only `String.toLowerCase()`, `String.includes()`, `String.startsWith()`, and strict equality checks. It also exports constant CSS class mappings keyed by tone. The module performs no I/O, contains no secrets or cryptographic material, executes no commands, makes no network requests, and accesses no filesystem or database. All callers (FlightCard, FlightHeader, DelayAnalysis, RotationHistory, +page.svelte) use the returned tone only to select from the hardcoded CSS class maps, which are rendered in Svelte `class:` directives — Svelte applies these via the DOM `className`/`classList` API, not via `innerHTML`, so there is no XSS vector even if a CSS class string were attacker-controlled (which it isn't — all values are literal constants in this file). The status strings originate from external scraper services, are stored in a `varchar(50)` PostgreSQL column, and are loaded via Drizzle ORM parameterized queries; no user-controlled input reaches the tone function through a writable path. After rigorous review of the anchor and all consumers, no exploitable vulnerability exists.
