---
"emdash": patch
---

Fixes category, tag, and search widget URLs on sites configured with an Astro `base`. Built-in sitemap routes now initialize correctly under the base instead of returning 500, and sitemap URLs and robots.txt sitemap references include the base path.
