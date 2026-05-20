---
"emdash": patch
---

Hydrate SEO data on entries returned by `getEmDashEntry` and `getEmDashCollection`.

Previously, `entry.data.seo` was always undefined because the live loader only reads columns from the content table — SEO is stored in a separate `_emdash_seo` table. Callers had to manually load SEO via an internal repo.

Now the SEO record is attached to `entry.data.seo` automatically (matching the existing pattern for bylines), as long as the collection has `has_seo = 1`. This makes `getSeoMeta(entry, ...)` work with the result of `getEmDashEntry` directly, as the `seo/index.ts` docstring already suggests.
