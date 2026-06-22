---
id: longshot-3e69cba5-000
phase: X2
anchor: apps/web/vite.config.ts
slug: no-finding
severity: none
confidence: high
---

## Summary
Standard SvelteKit + Vite 6 build configuration file with no exploitable vulnerabilities. The config loads `.env` via dotenv for the dev server (line 10), correctly externalizes database packages from the client bundle (lines 20–24), and pre-compresses assets (lines 15–16). Verified: (a) `$env/dynamic/private` is only imported in server-only files (`hooks.server.ts`, `+layout.server.ts`, `+server.ts`); (b) no `import.meta.env` or `process.env` accesses exist in any client-side `.svelte` file; (c) no `define` or `envPrefix` override exists that could leak non-`PUBLIC_` env vars to the client; (d) `build.sourcemap` defaults to `false` in production Vite 6 builds; (e) SvelteKit's `$env/dynamic/public` correctly filters to only `PUBLIC_`-prefixed variables. The `.env` file is properly gitignored. No trust boundary is crossed.
