---
"@emdash-cms/cloudflare": patch
---

Fixes a hang where a request cancelled mid-query on Cloudflare D1 could wedge the query-coalescing buffer: the flush timer scheduled by the cancelled request was dropped with it, leaving the coalescing flag stuck so every later query on the connection waited on a flush that never ran. The coalescing D1 and Durable Object SQL connections now treat a flush left pending past a short deadline as stranded and reschedule it, so a cancelled request can no longer stall subsequent queries.
