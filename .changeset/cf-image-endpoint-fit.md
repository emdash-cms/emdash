---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes Cloudflare image renditions ignoring Astro's `fit` and single-keyword `position` options. Images requested with `fit="cover"` now crop to fill their box, and `cover`, `contain`, and `inside` never enlarge small sources. `fill` uses Cloudflare's `squeeze` mode, which can enlarge small sources.

Cached renditions refresh after upgrading and whenever the crop position changes.
