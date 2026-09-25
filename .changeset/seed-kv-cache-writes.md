---
"emdash": patch
---

Fixes `kvCache()` rate-limit (429) errors, logged as `[object-cache] epoch bump failed`, when a seed with sample content is applied on Cloudflare Workers, such as through the setup wizard's **Include sample content** option. Applying a seed now writes each invalidated cache key to KV once, when the seed finishes, instead of once per entry.
