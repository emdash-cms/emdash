---
"@emdash-cms/registry-verification": patch
"emdash": patch
---

Fixes registry plugin installation and provenance verification failing with `module.require is not implemented` on Cloudflare Workers deployments whose adapter uses unenv's `node:module` shim.
