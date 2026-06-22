Everything is in order. Here's my summary:

---

**Longshot anchor 0ce8fc90 (packages/telegram/src/index.ts) complete. Drafts: 1.**

**Finding filed:** `longshot-0ce8fc90-001-sharp-edge-telegram-markdown.md`

**What I found:**

The `sendAlert` function has a **sharp-edge API design** — it unconditionally enables Telegram's Markdown parsing (`parse_mode: 'Markdown'`) but provides no built-in escaping, no exported escape utility, and no documentation requiring callers to escape their input. This is the **root cause** of the Markdown injection vulnerabilities already documented by two other anchors (`longshot-972053e7-001` and `longshot-70820091-001`) in the health monitor caller. Additionally, the module-level `sent` Map used for debouncing never evicts entries, creating a slow memory leak in long-running services.

**Severity: LOW** — The design flaw enables exploitation only when callers fail to escape. The already-documented health monitor caller is the concrete exploit path. The memory leak is an operational concern.

**Cross-file review conducted:** All 11 callers across 7 services (health-monitor, guernsey-scraper, fr24-scraper, adsb-service, weather-service, position-service, notification-service) were reviewed. No HTTP endpoints call `sendAlert` directly. No caller passes directly user-controlled input — all pass either hardcoded strings, database-derived data, or JavaScript `Error` objects from service operations.
