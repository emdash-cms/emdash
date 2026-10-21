---
"@emdash-cms/admin": patch
---

Fixes slugs, URLs, paths, URL patterns, regex patterns, emails, and other left-to-right values displaying in the wrong order when the admin uses a right-to-left language such as Arabic. For example, the URL pattern `/blog/{slug}` displayed as `blog/{slug}/`, and the regex `^[a-z0-9-]+$` as `$+[-a-z0-9]^`. These fields and their read-only displays, such as the redirects table, now always read left to right, while the surrounding labels and table layout stay right-to-left.
