---
"emdash": patch
---

Fixes the Node image endpoint returning a 500 for EmDash media that Astro's image service can't optimize. The endpoint now passes Astro's logger to the image service, so the service logs its warning and serves the original image.
