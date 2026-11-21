---
"emdash": patch
---

Stops the first request to a fresh isolate or process from writing to the database to release stale plugin cron locks. Scheduled maintenance (the Cloudflare Cron Trigger or the Node scheduler) still releases them on every run, so cold anonymous page views on D1 no longer go to the primary for this write.
