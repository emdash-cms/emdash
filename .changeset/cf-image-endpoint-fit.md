---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes cropping for EmDash media on Cloudflare. Images asked for a `cover` crop — square avatars, fixed-ratio thumbnails — came back scaled down and letterboxed inside the requested box instead of filling it, because the endpoint never passed the requested fit to the Images binding. `fit` and `position` are now honoured, so a crop crops and its focal side is respected.
