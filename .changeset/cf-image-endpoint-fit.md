---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes images on Cloudflare that set both `width` and `height` (including EmDash's `<Image>` and Astro's `<Image>` and `<Picture>`) being scaled down inside the box instead of cropped to fill it. `fit` is now honored, cropping and fitting never enlarge small sources, and a single-keyword `position` such as `top` or `left` controls which part is kept.
