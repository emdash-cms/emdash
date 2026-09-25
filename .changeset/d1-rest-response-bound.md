---
"@emdash-cms/cloudflare": patch
---

Fixes `emdash migrate` on Cloudflare D1 failing with `D1 response is too large` in `079_datetime_normalization`. The REST transport refused any response over 1 MiB, and a batch of fifty revisions with their bodies is several MiB on a site with real content. The default bound is now 64 MiB; `maxResponseBytes` still tightens it.
