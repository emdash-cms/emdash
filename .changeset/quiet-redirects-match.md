---
"emdash": patch
---

Match redirects whose source path contains non-ASCII characters.

The admin stores a redirect source exactly as the author typed it — normally raw Unicode — while the `pathname` the middleware compares it against is always percent-encoded by the URL parser. A rule for `/stitek/domácí-zvířata` therefore never matched, and visitors got a 404 instead of the redirect.

Sources are now normalized to their percent-encoded form when the rule cache is built, so exact-match and pattern rules both compare like for like. Normalization is idempotent: a source that is already percent-encoded (the previously undocumented workaround) is left as-is rather than double-encoded, Astro pattern syntax and trailing slashes are unaffected, and existing rules keep working without a data migration.
