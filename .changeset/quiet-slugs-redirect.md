---
"emdash": minor
---

Adds the collection option `autoSlugRedirects` so sites with custom routing can disable automatic redirects when a published entry's slug changes. Set `autoSlugRedirects: false` through the collection schema API, MCP collection tools, or a seed collection definition, then manage redirects for the site's actual public URLs manually.

The option defaults to `true` for existing and new collections. Omitting it preserves automatic redirect creation and chain collapse, including the `/{collection}/{slug}` fallback when no URL pattern is set. Disabling it does not delete existing redirect rules or change sitemap, menu, or preview URLs.
