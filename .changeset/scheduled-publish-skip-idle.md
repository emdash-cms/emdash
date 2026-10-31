---
"emdash": patch
---

Shortens each cron tick on sites with several collections, most noticeably on Cloudflare D1, where every query is a network round trip: the scheduled-publishing sweep now skips collections with nothing due instead of querying each of them twice.
