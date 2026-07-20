---
"emdash": patch
---

Stops draft-only saves and autosaves on published entries from advancing `updatedAt`. On revision-supporting collections, staging or discarding a pending draft leaves live content untouched, so sitemap `<lastmod>` and JSON-LD `dateModified` no longer register a modification until Publish actually changes the live entry.
