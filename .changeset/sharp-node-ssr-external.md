---
"emdash": patch
---

Fixes `/_image` transforms returning HTTP 500 (`MissingSharp`) on standalone Node.js builds (`@astrojs/node`). EmDash now loads `sharp` at runtime instead of bundling it into the server build, so existing Node.js sites, particularly those installed with pnpm, must list `sharp` in their own `dependencies` (`pnpm add sharp`). Cloudflare sites are unaffected.
