---
"emdash": patch
---

Fixes two content API and MCP actions that look up an entry by ID or slug and could check permissions against a different entry than the one they then changed:

- Creating a translation with `translationOf` (REST and the MCP `content_create` tool) now adds the translation to the entry whose edit permission was checked. Previously, a `translationOf` value that was one entry's slug and another entry's ID could link the translation to the second entry.
- Restoring a revision (`POST /_emdash/api/revisions/{id}/restore` and the MCP `revision_restore` tool) now answers `NOT_FOUND` when the revision's entry ID resolves to a different entry, instead of checking permissions on that entry and restoring the revision onto the original one.
