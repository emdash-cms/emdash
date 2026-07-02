---
"@emdash-cms/cloudflare": patch
---

Documents that D1 read replica sessions (`session: "auto"` / `"primary-first"`) are incompatible with the `global_fetch_strictly_public` compatibility flag, which silently blocks the D1 Sessions API and hangs every SSR request without logging an error.
