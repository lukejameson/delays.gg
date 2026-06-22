Longshot anchor d104c86d (apps/fr24-scraper/src/scraper.ts) complete. Drafts: 1 (no-finding).

**Summary of review:** The scraper reads flight data from FlightRadar24's DOM via Puppeteer and stores it in PostgreSQL through Drizzle ORM. I traced every data path from entry (FR24 HTML extraction) through all processing functions to sinks (database, shell commands, Telegram alerts). Key findings:

- **`execSync` in `forceKillBrowser`**: Both `ps aux | grep` and `rm -rf` use hardcoded strings — no user input reaches the shell.
- **Database operations**: All use Drizzle's parameterized `eq()`, `and()`, etc. — no SQL injection.
- **URL construction**: `flightNumber` is sanitized (whitespace removed, uppercased) and the domain is hardcoded to `flightradar24.com` — no SSRF.
- **`page.evaluate` calls**: All parameters are hardcoded strings or random numbers — no injection into browser context.
- **Sharp edges noted but not exploitable**: Redundant `require('child_process')`, `rm -rf` with shell glob expansion on hardcoded `/tmp` paths, `Record<string, unknown>` for dynamic update objects.
