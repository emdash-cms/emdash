---
"@emdash-cms/admin": patch
---

Fixes the WordPress import's media step stopping partway with "No result received from media import" on Cloudflare Workers Paid, where a batch of large photos could exceed the default 30-second CPU limit. The admin now imports media in smaller batches to stay within that limit.
