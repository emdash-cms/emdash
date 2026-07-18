---
"emdash": minor
---

Expose the host Astro project's `trailingSlash` config to plugins via `ctx.site.trailingSlash`, so plugins that build absolute URLs (sitemaps, canonical, hreflang) can match the site's routing policy. Available to in-process and sandboxed plugins alike.
