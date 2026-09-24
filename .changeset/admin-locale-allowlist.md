---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds a build-time `admin.locales` allowlist for shipping only the admin UI locales a site uses.

Configure it in your Astro config:

```js
emdash({
	admin: { locales: ["en"] },
});
```

- Only the listed locales are bundled into the production build. With `admin.locales: ["en"]` on a default EmDash install, only the English catalog remains in the bundle; the other 27 locale catalogs (≈3 MB) are dropped.
- Astro emits separate client and server builds, so the kept catalog appears once in each output as a `messages-*` chunk. With `["en"]` this results in two `messages-*` chunks, both containing the English catalog.
- The admin locale switcher and settings panel are filtered to show only the listed locales, so users cannot select a locale whose catalog was excluded.
- Requests for an unlisted locale fall back to the source catalog (English) instead of failing.
- The source locale (`en`) must be included — lists that omit it, such as `["en-GB"]`, are rejected at config validation so a fallback catalog is always available.
- Pseudo-localization support is filtered by the allowlist the same way as real locales; add `"pseudo"` only in development when `EMDASH_PSEUDO_LOCALE=1` is set.
