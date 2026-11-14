---
"emdash": patch
---

Fixes layout prefetching on anonymous Astro i18n pages to load menus and taxonomy terms in the page's locale, avoiding duplicate reads when layouts request that locale explicitly.
