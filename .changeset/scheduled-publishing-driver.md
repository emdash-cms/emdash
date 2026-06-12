---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Drive scheduled publishing from a real heartbeat instead of request side effects (#1303).

Content scheduled via the admin now actually transitions to `published` when its time arrives. Previously nothing promoted the row — `status` stayed `scheduled` and `published_at` stayed null forever.

A new sweep (`publishDueContent`) promotes due content and runs alongside the existing cron tick and system cleanup:

- **Node / single-process:** the timer-based scheduler already drives it — no action needed.
- **Cloudflare Workers:** a `scheduled()` handler driven by a Cron Trigger now runs the sweep. The request-driven `PiggybackScheduler` is gone, so there are no maintenance side effects on visitor requests.

`@emdash-cms/cloudflare` ships a Worker entry that wraps Astro's handler with the `scheduled()` handler (`@emdash-cms/cloudflare/worker`, plus `createScheduledHandler()` for hand-assembled Workers). When a cache provider is configured, the handler also purges edge-cache tags for whatever it published, so stale snapshots produced before the scheduled time are evicted.

**Migration for existing Cloudflare sites.** New sites get this from the templates. Existing deployments must update two files:

```ts
// src/worker.ts
export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";
```

```jsonc
// wrangler.jsonc
"triggers": { "crons": ["* * * * *"] }
```

Without the Cron Trigger, scheduled publishing and plugin cron do not run on Workers.

Scheduled publishing matches manual publishing exactly: it fires `content:afterPublish` hooks (search indexing, webhooks, syndication), and records the _scheduled_ time as `published_at` on first publication rather than the (later) sweep time. The sweep claims each row atomically before promoting it, so an entry unscheduled or rescheduled just before its time is never published, and overlapping sweeps can't double-publish. Local `astro dev` keeps running the timer-driven sweep even under the Cloudflare adapter (where production relies on the Cron Trigger).

Each tick promotes at most 100 items per collection (a large backlog drains over successive ticks) so a single Worker invocation can't exhaust its CPU/subrequest budget, and edge-cache tags are purged incrementally after each collection's batch rather than only at the end. On Node, the maintenance interval is capped at 60s so scheduled-publish latency matches the Cloudflare Cron Trigger cadence instead of lagging up to five minutes when no plugin cron is due.
