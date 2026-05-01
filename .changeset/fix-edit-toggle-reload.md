---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Switches the visual editing and playground toolbar's edit-mode toggle from `document.startViewTransition(() => location.replace(location.href))` to a direct `location.reload()`. `location.reload()` is the correct primitive for "re-run the server with the new cookie": it always revalidates with the server, never serves from cache, and avoids wrapping a cross-document navigation in a same-document view-transition primitive. Related: #878.
