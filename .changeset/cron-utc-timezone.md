---
"emdash": patch
---

Fixes plugin cron schedules (`ctx.cron.schedule()` with `@daily`, `@hourly`, or standard cron expressions) so they resolve in UTC on every host. Node self-hosts previously resolved them in the server's `TZ`, so the same schedule fired at a different time than on Cloudflare Workers, which always runs in UTC.

Node deployments whose `TZ` is not UTC will see recurring plugin tasks move after upgrading: `0 2 * * *` now runs at 02:00 UTC instead of 02:00 local time, and schedules no longer shift with daylight saving time. Each task switches the next time it runs or is rescheduled. Cloudflare Workers deployments and one-shot ISO 8601 schedules are unchanged. Plugin authors who need a local wall-clock time should write the expression in UTC; host-timezone resolution cannot be restored.
