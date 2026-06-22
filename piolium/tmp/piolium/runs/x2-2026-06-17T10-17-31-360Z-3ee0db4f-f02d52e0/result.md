Targets.json updated. The hunt for `apps/web/src/lib/delays.ts` is complete.

---

**Longshot anchor 3ee0db4f (apps/web/src/lib/delays.ts) complete. Drafts: 1.**

**Summary:** Dead utility file. Five pure functions (`calculateDelayMinutes`, `formatDelay`, `formatEarly`, `isDelayed`, `isEarly`) — all perform only arithmetic and `Date` parsing on primitive inputs. Zero imports anywhere in the repository. No I/O, no network, no database, no filesystem, no `eval`, no prototype pollution vectors, no authn/authz. No security vulnerability present.
