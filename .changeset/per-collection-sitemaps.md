---
"emdash": minor
---

Per-collection sitemaps with sitemap index and lastmod

`/sitemap.xml` now serves a `<sitemapindex>` with one child sitemap per SEO-enabled collection. Each collection's sitemap is at `/sitemap-{collection}.xml` with `<lastmod>` on both index entries and individual URLs. Uses the collection's `url_pattern` for correct URL building.
