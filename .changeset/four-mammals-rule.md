---
"emdash": patch
---

Fixes `decodeSlug()` so malformed percent-escaped slugs return `undefined` instead of throwing, letting `[slug]` pages fall through to their 404 handling.
