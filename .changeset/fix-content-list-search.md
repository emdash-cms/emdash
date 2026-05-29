---
"emdash": patch
"@emdash-cms/admin": patch
---

Make content list search work on large collections (#1219). The admin content list previously filtered only the rows already loaded on the current page, so an entry far back in a big collection could not be found until you navigated near it. The list endpoint now accepts a `q` parameter and performs a case-insensitive substring search across the collection's title/name/slug columns server-side (LIKE wildcards in the query are escaped), and the admin search box drives that query (debounced) instead of filtering in memory. Also adds locale-aware composite indexes (`idx_{table}_deleted_locale_updated_id` / `_created_id`) so locale-filtered content lists stay index-served on large, i18n-enabled tables.
