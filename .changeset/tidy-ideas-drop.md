---
"emdash": patch
---

Fires `content:afterPublish` hooks for each item published by the scheduled publish-due cron job, and triggers rebuild hooks once per batch instead of per item.
