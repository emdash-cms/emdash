---
"emdash": patch
---

Fixes KV rate-limit errors when a seed with sample content is applied on Cloudflare Workers with the KV object cache (`kvCache()`): applying a seed now writes each cache invalidation to KV once instead of once per entry.
