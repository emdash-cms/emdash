---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes cropping for EmDash media on Cloudflare. An image asked to fill a fixed box — a square avatar, a fixed-ratio thumbnail — came back scaled down and letterboxed inside it, because the endpoint never passed the requested fit to the Images binding. `fit` and `position` are now honoured, so a crop crops and its focal side is respected.
