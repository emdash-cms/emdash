---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes JSDoc for external authentication roles so config-time types and examples use the canonical RBAC names. Role level 30 is now labeled Author (can create, edit, and publish own content), and role level 40 is labeled Editor. No runtime behavior changed.
