---
"emdash": patch
---

Reduces `getComments()` to a single database query when the approved comment list fits on one page.

Pages rendering comments previously ran a `COUNT` query followed by the list query, even when the result was not truncated. `getComments()` now fetches the list first and derives the total from the returned rows whenever cursor pagination indicates there are no more pages, falling back to `COUNT` only for posts that exceed the page limit. Cache misses on sites without an object cache benefit most.
