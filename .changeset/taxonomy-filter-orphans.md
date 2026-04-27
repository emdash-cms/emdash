---
"emdash": patch
---

Fixes `taxonomy_list` exposing collection slugs for collections that no longer exist. Orphaned slugs are filtered out so the response stays consistent with `schema_list_collections`.
