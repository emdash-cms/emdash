---
"emdash": minor
---

Make the preview URL pattern locale-aware. `getPreviewUrl()` now accepts a `{locale}` placeholder and a `locale` option (empty string collapses adjacent slashes so default-locale entries on `prefixDefaultLocale: false` sites stay unprefixed). The `POST /_emdash/api/content/{collection}/{id}/preview-url` route resolves the locale automatically from the entry and the site's i18n config, and reads a project-wide default pattern from the new `EMDASH_PREVIEW_PATH_PATTERN` env var so the admin's "View on site" link can match locale-prefixed routes (e.g. `/{locale}/{id}`).
