---
"emdash": patch
---

Fixes every-minute cron ticks exceeding the Workers Free CPU limit on cold isolates by running system cleanup once per hour instead of on every tick. The scheduled-publish sweep, cron tasks, and heartbeat still run each minute; bookkeeping cleanups now run only on the top of the hour.
