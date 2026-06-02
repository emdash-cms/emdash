---
"emdash": patch
---

Fix SEO fields (noindex toggle, canonical URL) not affecting rendered pages. The content loader now surfaces per-entry SEO metadata on `entry.data.seo`, so `getSeoMeta()` reflects values set in the admin SEO panel. SEO is folded into the existing entry query via a LEFT JOIN, adding no extra database round-trips.
