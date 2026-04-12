---
"emdash": patch
---

Fixes manifest version being hardcoded to "0.1.0". The version and git commit SHA are now injected at build time via tsdown/Vite `define`, reading from package.json and `git rev-parse`.
