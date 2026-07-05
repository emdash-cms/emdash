---
"emdash": patch
---

Fix OAuth env detection for Astro v6 + `@astrojs/cloudflare` v14 by using `import("cloudflare:workers")` with fallback to `locals.runtime?.env` then `import.meta.env`. Also fix autosave persistence by updating `ec_pages.content` after revision updates, and skip no-op autosave updates when content hasn't changed.
