---
"emdash": patch
---

Adds `after(fn)` — a helper for deferring bookkeeping work past the HTTP response. On Cloudflare it hands off to `waitUntil` (extending the worker's lifetime); on Node it fire-and-forgets (the event loop keeps the process alive for the next request anyway). Host binding is plumbed through a new `virtual:emdash/wait-until` virtual module so core stays runtime-neutral — Cloudflare-specific imports live in the integration layer, not in request-handling code.

First use: cron stale-lock recovery (`_emdash_cron_tasks` UPDATE) now runs after the response ships instead of blocking it. On D1 this shaves a primary-routed write off the cold-start critical path.

Usage:

```ts
import { after } from "emdash";

// Fire-and-forget; errors are caught and logged so a deferred task
// never surfaces as an unhandled rejection.
after(async () => {
	await recordAuditEntry();
});
```
