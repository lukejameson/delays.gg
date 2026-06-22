---
Phase: 2
Sequence: 000
Slug: no-finding
Verdict: NO-FINDING
Severity-Original: NONE
Confidence: high
Anchor: apps/adsb-service/src/lookup.ts
Anchor-Sha8: 9129cb5e
---
## Summary

`lookupByHex()` is a background-service utility that queries community ADS-B aggregator APIs using a hardcoded ICAO24 hex address from `AURIGNY_FLEET`. No user-controlled input reaches the function. The external API response is parsed via standard `res.json()` and all response fields flow into Drizzle ORM parameterized queries — no SQL injection, no unsafe deserialization, no command injection, no SSRF vector. The service exposes no HTTP server and is not imported by any other package. After exhaustive review of the anchor, its sole caller (`apps/adsb-service/src/index.ts`), and downstream data flows, no exploitable vulnerability was found.
