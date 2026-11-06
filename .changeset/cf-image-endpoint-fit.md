---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes Cloudflare image renditions ignoring Astro's `fit` and single-keyword `position` options. Images requested with `fit="cover"` now crop to fill their box, and `cover`, `contain`, and `inside` never enlarge small sources. `fill` uses Cloudflare's `squeeze` mode, which can enlarge small sources.

Cached renditions that revalidate by ETag refresh after upgrading, and renditions with different crop positions no longer share an ETag. On both Node and Cloudflare, image requests with a `fit` or `position` value that is not valid in an HTTP header no longer fail with a 500 error.
