---
"emdash": patch
---

Fixes `/_image` media transforms failing with `MissingSharp` (HTTP 500) on standalone Node.js builds when `sharp` is resolved at runtime. Sites deployed with `@astrojs/node` under `pnpm` or other strict package managers still need `sharp` declared in the application's `dependencies`.
