---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Removes scheduled Media Usage recovery APIs. Remove any dedicated Media Usage Cron trigger, call `createScheduledHandler()` without `mediaUsageCron` or `resolveMediaUsageQueue`, and update custom Node schedulers to implement the continuous Media Usage callback and wake methods.
