---
"emdash": patch
---

Fixes the inline Portable Text editor failing to hydrate in development when visual editing is enabled. The editor's code-block extension loads lowlight, which default-imports a CommonJS highlight.js module. The Vite client optimizer now pre-bundles `lowlight`, `highlight.js`, and `highlight.js/lib/core` so the deep CJS import is wrapped with ESM interop before it reaches the browser.
