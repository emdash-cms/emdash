---
"emdash": patch
---

Fixes the dev server on Windows, where the admin failed to load with "Could not resolve babel-plugin-macros". Lingui macros in admin source files are now compiled on Windows too, so `pnpm dev` in the monorepo demos and templates works on every platform.
