---
"@emdash-cms/registry-verification": minor
---

Adds a validated file inventory to `validatePluginBundle`: the result now carries `files`, every regular archive file (path and bytes) in tar order, so consumers can extract analysis inputs without re-parsing the bundle.
