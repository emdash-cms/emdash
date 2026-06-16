---
"emdash": patch
---

The admin shell now uses the Site Icon configured in Settings → General as its favicon, so the EmDash backend is branded like the public site. Falls back to the build-time `admin.favicon` config and then the default EmDash mark when no Site Icon is set.
