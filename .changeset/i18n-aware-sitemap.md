---
"emdash": minor
---

The per-collection sitemap (`/sitemap-{collection}.xml`) is now i18n-aware. When Astro i18n is enabled, each translation row is emitted as its own `<url>` with the correct locale prefix (resolved via Astro's own `getRelativeLocaleUrl`, so `prefixDefaultLocale` and custom `path` mappings are honoured). Every entry also lists its sibling translations as `<xhtml:link rel="alternate" hreflang="...">` (plus `x-default` for the default-locale variant), grouped by `translation_group`. Sites with a single locale or no i18n configured are unaffected -- their sitemap XML is unchanged.
