---
"@emdash-cms/registry-loader": minor
"@emdash-cms/registry-lexicons": patch
---

Adds `registryLoader()` for reading the moderated EmDash plugin registry through Astro live content collections. Collection loads support free-text and exact publisher/package searches, capability filters, and limits. Single-entry loads resolve a publisher handle or DID and include the latest visible release when one exists.

Registry searches recognize exact handles, DIDs, and identity/slug pairs. Package views include the publisher's current verified handle when available.
