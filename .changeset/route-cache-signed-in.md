---
"emdash": patch
---

Fixes Astro route rules caching responses that belong to one visitor. With a cache provider such as `cacheCloudflare()`, a page rendered for a signed-in user (for example a comment form showing their name and email) could be stored and served to anonymous visitors, and a catch-all rule such as `/[...slug]` could store EmDash admin API responses or anonymous `401` responses and serve them to other users.

Responses rendered for a signed-in user, and responses sent with `Cache-Control: private` or `no-store`, are no longer stored in the route cache. This includes EmDash API responses such as `/_emdash/api/search`, so route rules no longer cache them. A page requested by a signed-in user is filled into the cache by the next anonymous visitor instead.
