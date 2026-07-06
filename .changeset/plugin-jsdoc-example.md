---
"emdash": patch
---

Fixes the plugin registration example in the `emdash()` options JSDoc: plugins are registered as default-export descriptors (`plugins: [auditLog]`), not via `auditLogPlugin()`-style factory calls, which have never existed.
