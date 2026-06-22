---
"emdash": patch
---

Fixes a Cloudflare build failure where the bare `zod` import used by the type generator was not externalized, causing the bundler to fail. EmDash sites on Cloudflare now build correctly under Astro 7.
