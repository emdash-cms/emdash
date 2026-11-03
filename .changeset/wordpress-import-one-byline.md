---
"emdash": patch
---

Fixes the WordPress importer creating a new guest byline for the same author every 30 posts. An author who is not mapped to a user now gets one byline for the whole import, so their posts are no longer split between `author`, `author-2`, `author-3` and so on.
