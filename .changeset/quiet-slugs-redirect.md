---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds **Automatic slug redirects** to the collection editor so sites with custom routing can disable automatic redirects when a published entry's slug changes. Open the collection under **Content Types**, turn off the setting below **URL Pattern**, and save. Manage redirects for the site's actual public URLs manually. The same setting is available as `autoSlugRedirects: false` through the collection schema API, MCP collection tools, and seed collection definitions.

The option defaults to `true` for existing and new collections. Omitting it preserves automatic redirect creation and chain collapse, including the `/{collection}/{slug}` fallback when no URL pattern is set. Disabling it does not delete existing redirect rules or change sitemap, menu, or preview URLs.
