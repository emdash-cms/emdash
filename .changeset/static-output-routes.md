---
"emdash": patch
---

Fixes `astro build` failing with `GetStaticPathsRequired` inside an EmDash route when the Astro config sets `output: "static"`. Every route EmDash adds, including the admin, the API, `sitemap.xml`, and `robots.txt`, now renders on demand under either output setting, so a static-output site still needs a server adapter. The site's own pages keep Astro's default: under `output: "static"` they prerender at build time and show content from that build. Builds with `output: "server"` are unchanged.
