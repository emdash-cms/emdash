---
"@emdash-cms/cloudflare": patch
---

Fixes `emdash migrate` on D1 failing with no hint about how to select a database. When neither `--d1` nor `--wrangler-config` is given, the error now names both options and the binding the build expects, and says that a Wrangler config in the project root is not read unless it is named.
