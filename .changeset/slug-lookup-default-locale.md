---
"emdash": patch
---

Fixes slug lookups that name no locale picking an arbitrary or lowest-code entry when entries in several locales share the slug.

- `getEmDashEntry` without a locale returns the default locale's published entry. An entry whose ID matches comes before one whose slug equals that ID, and a draft no longer hides a published entry with the same slug.
- Reads by slug through the REST API, CLI, `EmDashClient` and MCP return the default locale's entry, falling back to the lowest locale code only when the default locale has none.
- Changes addressed by a slug that exists in more than one locale now fail with `AMBIGUOUS_LOCALE` (400) unless the request names a locale. This covers update, delete, permanent delete, restore, publish, unpublish, schedule, unschedule, discard-draft, duplicate, edit locks, term assignment and plugin editor actions, through REST, the CLI, `EmDashClient` and MCP. Scripts that act on shared slugs without a locale must pass one or use the entry's ID. Changes addressed by ID are unaffected.
- Restore and permanent delete by slug prefer a trashed entry over a live entry with the same slug.

To name a locale, `emdash content delete`, `publish`, `unpublish`, `schedule` and `restore` now accept `--locale`. The matching `EmDashClient` methods accept a `locale` option, the restore and permanent-delete endpoints accept `?locale=`, and the MCP tools `content_delete`, `content_restore`, `content_permanent_delete`, `content_publish`, `content_unpublish`, `content_schedule`, `content_unschedule` and `content_discard_draft` accept a `locale` argument.
