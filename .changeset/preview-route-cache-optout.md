---
"emdash": patch
---

Fixes preview and editor-toolbar responses being stored in the shared edge cache when route caching is enabled: requests with a `_preview` token and toolbar-injected editor pages now opt out of the route cache, so draft content is no longer served from the cache without token verification and toolbar markup no longer leaks to anonymous visitors.
