---
"emdash": patch
---

Fixes locale-aware content queries when Astro locales use custom paths and codes, such as `{ path: "en", codes: ["en-US"] }`. Passing `Astro.currentLocale` to `getEmDashEntry` or `getEmDashCollection` now finds content stored under the configured path instead of missing it or returning fallback content. Writes using a configured code also use the same path-based locale identity.
