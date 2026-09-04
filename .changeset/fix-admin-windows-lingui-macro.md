---
"emdash": patch
---

Fixes the admin UI failing to load in dev mode on Windows (stuck on "Loading EmDash..." with a `babel-plugin-macros` / `process is not defined` console error). The Lingui macro compiler that runs against admin source in local-monorepo dev never matched any files on Windows, so `@lingui/core/macro` imports shipped uncompiled to the browser instead of being transformed away.
