---
"emdash": patch
---

Fixes sandboxed plugin startup on Cloudflare Worker Loader when host builds preserve function names, so plugin HTTP helpers do not depend on bundler-generated globals.
