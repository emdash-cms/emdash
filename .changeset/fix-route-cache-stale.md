---
"emdash": patch
---

Fixes purged Astro route-cache pages being cached again with outdated site settings and taxonomy definitions, including on sites without an object cache. Route-cache fills read fresh settings and taxonomy data instead of reusing another server process's old snapshot.

Sites with an Astro cache provider perform fresh settings and taxonomy reads on rendered requests, including routes that ultimately remain uncached. This increases database queries on the render/miss path; edge-cache hits do not run these queries.

Removes automatic `Last-Modified` validators from collection, publication-date, and reference-list cache hints. The newest modification time of the listed rows does not cover deletions, unpublishes, or settings changes, so conditional refreshes could keep stale list bodies visible indefinitely. Collection pages that relied on these automatic validators lose Astro's implicit `Cache-Control: no-cache` header and conditional `304` revalidation; set browser `Cache-Control` explicitly if you need a fresh check on every visit. Single-entry hints still carry an automatic `Last-Modified` validator from the entry's `updated_at`. Explicit custom validators remain supported, but must cover every dependency of the response.
