---
"emdash": patch
---

Fixes layout prefetching on anonymous multilingual Astro pages to load menus and taxonomy terms in the page's locale, avoiding duplicate reads when layouts request that locale explicitly. Sites with a single configured locale, or no i18n configuration, keep their existing prefetch behavior.

On non-default-locale pages, implicit `getMenu()` and `getTaxonomyTerms()` calls still return default-locale data, but now load it separately from the page-locale prefetch. This increases reads for implicit-locale layouts and EmDash's built-in menu widgets on translated pages, including pages whose other navigation already passes an explicit locale. Menu widgets retain their default-locale output; this patch does not change which content they render. Layouts intended to render translated navigation should pass `{ locale: Astro.currentLocale }` to these helpers to reuse the prefetched data.
