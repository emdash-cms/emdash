---
"emdash": patch
---

Fixes seed imports assigning taxonomy terms from another locale when slugs are shared across translations. Taxonomy references now resolve in the content entry's locale; a missing localized term produces a warning and skips that assignment instead of attaching a term from another locale.
