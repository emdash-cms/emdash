---
"emdash": minor
"@emdash-cms/admin": minor
---

Add a build-time `admin.locales` allowlist for shipping only the admin UI locales a site uses.

Configure it in your Astro config:

```js
emdash({
	admin: { locales: ["en"] },
});
```

- Only the listed locales are bundled into the production build. On a default EmDash install this drops 27 admin message catalogs (≈3 MB) when only English is needed.
- The admin locale switcher and settings panel are filtered to show only the listed locales, so users cannot select a locale whose catalog was excluded.
- Requests for an unlisted locale fall back to the source catalog (English) instead of failing.
- The source locale (`en`) must be included so a fallback catalog is always available.
- Pseudo-localization support is filtered by the allowlist the same way as real locales; add `"pseudo"` only in development when `EMDASH_PSEUDO_LOCALE=1` is set.
