---
"emdash": patch
---

Fixes LiveSearch result links ignoring the collection's `urlPattern`, which sent root-level pages to URLs such as `/pages/my-page` instead of `/my-page`. Search and autocomplete results now include a resolved `url` with date tokens and locale prefixes. Explicit `routeMap` entries still override the default links.
