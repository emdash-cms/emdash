---
"emdash": patch
---

Fixes `emdash migrate --from-config` failing with "Stripping types is currently unsupported for files under node_modules" when the Astro config imports a plugin that publishes TypeScript source, such as `@emdash-cms/plugin-forms`.
