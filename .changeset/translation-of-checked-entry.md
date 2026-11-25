---
"emdash": patch
---

Fixes creating a translation and restoring a revision so the permission check uses the same entry the action changes. Both now look up the entry by ID only:

- Creating a translation with `translationOf` (REST and the MCP `content_create` tool) checks edit permission on the entry with that ID. Previously, when that ID was also another entry's slug, the permission was checked against the other entry.
- Restoring a revision (`POST /_emdash/api/revisions/{id}/restore` and the MCP `revision_restore` tool) checks ownership of the revision's own entry, with the same correction.
