---
"emdash": patch
---

Fixes scheduled publishing so its recurring check no longer reads every content entry on each run. Sites running the scheduler on a frequent cron trigger, as the Cloudflare deployment guide recommends, previously saw database reads grow with the size of their content library rather than with the amount of scheduled work — a cost that is directly billable on D1 and was paid even when nothing was scheduled. Existing sites pick up the fix when migrations run on upgrade; no configuration or code changes are needed.
