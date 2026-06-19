---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Fixes responsive image optimization for storage-backed media on Cloudflare. EmDash now wraps Astro's image endpoint to read media bytes directly from your storage adapter instead of fetching them over HTTP, so `Image` and Portable Text images generate a real responsive `srcset` even when the site is behind Cloudflare Access (previously these 404'd and fell back to a full-size image). This is on by default and also removes an internal HTTP round-trip on Node. Set `images: false` in your `emdash()` config to leave Astro's image endpoint untouched.
