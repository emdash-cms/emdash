---
"emdash": patch
---

Closes the edge-cache gap where editing site settings or a menu never invalidated rendered HTML. Settings and menu write paths now purge reserved route-cache tags (`emdash:settings`, `emdash:menus`) on Cloudflare, and `<EmDashHead>` / menu widgets tag the pages they render so those purges reach them. Sites that call `getMenu()` directly can opt a page into the same invalidation with `Astro.cache.set({ tags: [EDGE_TAG_MENUS] })`. The Cloudflare deployment docs now explain that a publish only evicts cached pages whose tags line up, and show how to tag content, menus, and settings.
