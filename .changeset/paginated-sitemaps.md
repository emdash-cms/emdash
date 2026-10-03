---
"emdash": patch
---

Fixes collection sitemaps silently dropping entries beyond the first 50,000. Each `/sitemap-{collection}.xml` now holds up to 2,000 entries, ordered by entry ID instead of last update, and continues at `/sitemap-{collection}-2.xml`, `-3.xml`, and so on. `/sitemap.xml` lists every page with its own last-modified date, and translations that land on different pages still list each other as hreflang alternates.

#### What should I do?

Nothing, if search engines read `/sitemap.xml` and you have not replaced the sitemap routes. For collections with more than 2,000 listed entries:

- If you submitted a collection sitemap such as `/sitemap-post.xml` directly to a search console, submit `/sitemap.xml` instead so search engines find every page.
- If you replaced `src/pages/sitemap.xml.ts`, add `/sitemap-{collection}-{n}.xml` for each further page of 2,000 entries.
- If you replaced `src/pages/sitemap-[collection].xml.ts`, handle the `-{n}` suffix in the `collection` parameter (for example `post-2`) and serve that page of entries.
