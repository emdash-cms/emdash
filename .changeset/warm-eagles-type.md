---
"@emdash-cms/cloudflare": patch
---

Fixes imports of `d1()`, `r2()`, `kvCache()`, and other config descriptors when `wrangler` is not installed. Wrangler is now an optional peer dependency and is only loaded when calling `sandbox()`. Projects using `sandbox()` must still install `wrangler`.
