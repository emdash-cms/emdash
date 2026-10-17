---
"emdash": patch
---

Fixes site settings staying stale in long-lived Worker isolates after a change handled by another isolate. Settings snapshots now expire after 30 seconds, and route-cache fills read settings directly from the database so purged pages are not rebuilt with an old title, logo, or SEO verification tag.
