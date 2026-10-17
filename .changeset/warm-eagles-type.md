---
"@emdash-cms/cloudflare": patch
---

Fixes the root config entry point so `d1()`, `r2()`, `kvCache()`, and other descriptors can be imported when `wrangler` is not installed in the project. `wrangler` is now loaded lazily inside `sandbox()` rather than at module load time, and it is declared as an optional peer dependency.
