---
"emdash": minor
---

Adds MCP tools for managing taxonomy definitions: `taxonomy_get`, `taxonomy_create`, `taxonomy_update`, and `taxonomy_delete`.

These mirror the REST endpoints added in #2431, so MCP clients can now create taxonomies before adding terms instead of dropping out to a hand-rolled API call. `taxonomy_create` accepts `name`, `label`, `labelSingular`, `hierarchical`, `collections`, `locale`, and `translationOf`. When `translationOf` is used and `hierarchical` or `collections` are omitted, the new definition inherits them from the source taxonomy, fixing the defaulting trap described in #2525.
