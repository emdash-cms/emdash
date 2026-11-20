---
"emdash": patch
---

Fixes cached detail-page 404s staying stale after the missing entry is published. `getEmDashEntry` now returns the collection tag in `cacheHint` when no entry is found, so publishing the entry purges the cached 404. An entry found in the requested locale keeps only its own id and reference tags. An entry served from a fallback locale, or stored under a legacy locale code such as `en-US`, also carries the collection tag. Because the miss hint now has a tag, a 404 from a page that passes it can be cached for up to 60 seconds even without a route rule. To keep misses uncached, see [Error responses](https://docs.emdashcms.com/deployment/route-caching/#error-responses).

#### Upgrading

- Pass the `getEmDashEntry` hint to `Astro.cache.set()` before rewriting to `/404`.
- Remove the collection tag from detail route rules such as `/posts/[slug]`. It purged every detail page whenever any entry in the collection was published.
- On a detail page that lists other entries, such as recent posts, tag the ids of the entries it shows instead of passing the `getEmDashCollection` hint. A newly published entry appears in the list the next time the page renders.
- Widgets such as Recent Posts can't tag the page themselves. Run the widget's query in the page frontmatter and tag those ids, as the blog and starter templates now do.
