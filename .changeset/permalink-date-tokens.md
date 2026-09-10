---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds WordPress-style date tokens to collection URL patterns. `url_pattern` now supports `{year}`, `{month}`, `{day}`, `{hour}`, `{minute}`, `{second}` (resolved from the entry's publish date, zero-padded) alongside `{slug}` and `{id}` — so you can reproduce permalinks like `/{year}/{month}/{day}/{slug}.html`. The tokens resolve everywhere the pattern is used: sitemap canonical URLs, hreflang alternates, navigation menu links, slug-change auto-redirects, and the admin's preview and "View published" links. Tokens stay literal when an entry has no publish date, so canonical URLs remain stable across edits.
