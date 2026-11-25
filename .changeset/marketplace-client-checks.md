---
"emdash": patch
---

Fixes several behaviours of the legacy `marketplace` option. Sites that do not set `marketplace` are unaffected.

- Plugin and theme search and detail lookups, update checks, installs, and updates follow redirects only while they stay on the marketplace origin. A redirect to another host is refused: installs and updates fail with `MARKETPLACE_REDIRECT_UNTRUSTED`, search and detail lookups fail with their usual error, and update checks skip the affected plugin. The install statistics request follows no redirects.
- The plugin icon and theme thumbnail proxies relay only PNG, JPEG, and WebP images, served as downloads. Other responses, including the marketplace's generated SVG fallback avatars, return `502 PROXY_ERROR`; an upstream 404 returns `404 NOT_FOUND`. Rejected upstream response bodies are no longer passed through.
- Installing a marketplace plugin fails with `PLUGIN_ID_CONFLICT` when the ID is already used by a `sandboxed: []` plugin or by a plugin installed from another source.
- Plugin bundles whose file names repeat, including `package/backend.js` next to `backend.js`, are refused with `INVALID_BUNDLE`.
