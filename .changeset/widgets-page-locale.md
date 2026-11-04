---
"emdash": patch
---

Fixes the Categories, Tags, Recent Posts and Archives widgets showing visitors the default language on translated pages. They now list the terms, posts and months of the page's own locale, as signed-in editors already saw, and link under that locale, such as `/en/category/news`, `/en/archives/2025/01` and `/en/posts/museum-news`. A Recent Posts `urlTemplate` gets the locale prefix too, after Astro's `base` when the template starts with it, unless the template already has the prefix.

Recent Posts links to translated posts change from `/posts/en/museum-news` to `/en/posts/museum-news`, the shape Astro's locale routing and the EmDash templates use.
