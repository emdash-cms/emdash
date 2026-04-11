---
"emdash": patch
---

Allows external HTTPS images in the admin UI by adding `https:` to the `img-src` CSP directive. Fixes external content images (e.g. from migration or external hosting) being blocked in the content editor.
