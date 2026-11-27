---
"emdash": patch
---

Fixes `Image` from `emdash/ui` and the Portable Text image and gallery blocks so SVG media without `formats` renders as a plain `<img>` with the original media URL. On Astro 6.4 and later, each SVG previously got a `srcset` of `/_image` URLs, one per width, that all returned the same unchanged SVG file, so browsers and caches fetched it under several URLs. SVGs rendered with `formats` are still sent to the image service.
