---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds WordPress-style date tokens to collection URL patterns. `url_pattern` now supports `{year}`, `{month}`, `{day}`, `{hour}`, `{minute}`, `{second}` (resolved from the entry's publish date, zero-padded) alongside `{slug}` and `{id}` — so you can reproduce permalinks like `/{year}/{month}/{day}/{slug}.html`. The tokens resolve in sitemap canonical URLs and the admin "View published" links.
