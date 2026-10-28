---
"emdash": patch
---

Fixes the public Image component and Portable Text image and gallery blocks emitting duplicate `srcset` URLs when Astro’s image service returns the source URL unchanged. These images now render without generated `srcset` or `sizes`; resizing still requires a working image service.
