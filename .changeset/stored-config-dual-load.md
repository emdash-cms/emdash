---
"emdash": patch
---

Fixes stored config sharing when the runtime module is loaded as both compiled `dist` and raw `src` in the same process (Vite SSR / dual-package). The integration config is now keyed on a global `Symbol.for` registry entry instead of a typed `globalThis` var, matching the existing isolate-singleton pattern, so `getStoredConfig()` resolves consistently across both module copies.
