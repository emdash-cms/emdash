---
"emdash": patch
---

The admin shell now falls back to the Site Icon configured in Settings → General for its favicon, so the EmDash backend is branded like the public site. An explicit build-time `admin.favicon` still takes precedence, and the default EmDash mark is used when neither is set.
