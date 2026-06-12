---
"emdash": patch
---

Plugin cron tasks now actually run on Cloudflare Workers (#1422)

The middleware selected the `PiggybackScheduler` on Workers, but nothing ever
called `runtime.tickCron()`, so scheduled plugin tasks sat overdue at
`status = idle` forever. The middleware now ticks the cron system once per
request (both the anonymous fast path and the full runtime path). The
scheduler debounces internally (60s) and runs fire-and-forget, so requests
gain no latency.
