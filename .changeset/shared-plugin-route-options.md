---
"emdash": patch
"@emdash-cms/plugin-cli": patch
"@emdash-cms/plugin-types": patch
---

Fixes plugin route options being lost during bundling and manifest validation. The standalone plugin CLI now preserves `cacheControl`, core's descriptor bundler preserves route permissions, and the shared manifest validator retains both fields. Rebuild affected plugin bundles to include options omitted by an older CLI.
