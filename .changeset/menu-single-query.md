---
"emdash": patch
---

Reduces database queries when rendering navigation menus with `getMenu()` and `getMenuWithCacheHint()`: a menu and its items now load in a single query, including when the menu falls back to another locale, saving at least one query per menu that isn't already served from the object cache. With an object cache configured, logged-out HTML page loads on Cloudflare D1 and Durable Object databases also skip one more query per request, and menus created or removed by seeding, WordPress import, or site transfer show up without waiting for the cache to expire.
