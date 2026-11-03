---
"emdash": patch
---

Fixes WordPress WXR file imports creating a new guest byline for the same author every 30 posts. An author who is not mapped to a user now gets one byline for the whole file import, so their posts are no longer split between `author`, `author-2`, `author-3` and so on. Imports through the WordPress plugin connector (EmDash Exporter) are not yet covered by this fix.
