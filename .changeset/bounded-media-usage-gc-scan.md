---
"emdash": patch
---

Fixes scheduled media-usage cleanup reading far more rows than its batch size on large sites. A cleanup run that had lost its lease scanned the whole occurrence table before returning nothing, so cron ticks could spike into the hundreds of thousands of rows read. Sites on Cloudflare D1 will see those spikes disappear.
