---
"emdash": patch
---

Fixes MCP schema tools to accept URL and repeater fields, widget configuration and field sort order on creation, and collection admin settings, visibility and sidebar order on update. Adds `schema_reorder_fields` to reorder a collection's fields in one call.

`schema_create_field` now creates reference fields the same way as the REST API: set `validation.targetCollection` to create a relation, or `validation.relation` to bind an existing one. The older `options.collection` target remains accepted and now also creates a relation. A reference field with neither a target collection nor an existing relation is now rejected with `VALIDATION_ERROR` instead of being created without a relation.
