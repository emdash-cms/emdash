---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes the visual editing toolbar's edit-mode toggle so it actually flips state on click. The toggle handler wrapped a same-URL `location.replace(location.href)` in `document.startViewTransition`. View transitions are a same-document SPA primitive — wrapping a cross-document navigation in one races the document unload, and the same-URL replace can be served from cache or the bfcache without re-running the server, so the freshly-set `emdash-edit-mode` cookie never round-trips. The toggle now calls `location.reload()` directly, which always revalidates and renders edit-mode state correctly.
