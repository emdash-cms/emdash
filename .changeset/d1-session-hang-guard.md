---
"@emdash-cms/cloudflare": patch
---

Fixes every SSR request hanging indefinitely when D1 read replica sessions (`session: "auto"` / `"primary-first"`) are combined with an environment that silently blocks the D1 Sessions API (such as the `global_fetch_strictly_public` compatibility flag). The first session query that never settles now falls back to the direct D1 binding after a short timeout, logs a descriptive error, and disables sessions for the rest of the isolate instead of hanging until the Worker is killed.
