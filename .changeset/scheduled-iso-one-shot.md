---
"emdash": patch
---

Fixes ISO date-time plugin schedules being treated as recurring tasks when the cron parser accepts the timestamp. A successful one-shot task is now removed after it runs.
