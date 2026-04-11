---
"emdash": patch
---

Fixes SEO hydration exceeding D1 SQL variable limit on large collections by chunking the `content_id IN (...)` clause in `SeoRepository.getMany`.
