---
"emdash": patch
---

Fixes taxonomy and menu translations being accepted under a different name than their source. Creating a taxonomy or a menu with `translationOf` through the REST API or the MCP `taxonomy_create` and `menu_create` tools now returns a validation error unless `name` matches the source.
