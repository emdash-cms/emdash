---
"emdash": patch
---

Fixes phantom `no such table: ec_*` database errors filling the logs on sites whose taxonomies declare a collection that doesn't exist — including the default `category`/`tag` taxonomies, which are bound to `posts` even when that collection was never created. Term counts now resolve the existing content tables upfront (cached per isolate) instead of probing the missing table and retrying on every uncached render.
