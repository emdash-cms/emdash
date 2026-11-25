---
"emdash": patch
---

Fixes slug lookups that name no locale picking an arbitrary or lowest-code locale when entries in several locales share the slug. `getEmDashEntry` without a locale now returns the default locale's published entry, prefers an entry whose ID matches over one whose slug equals that ID, and no longer lets a draft hide a published entry with the same slug. Slug-addressed REST, CLI, `EmDashClient` and MCP actions resolve to the default locale's entry as well, falling back to the lowest locale code only when the default locale has no entry with that slug.

`emdash content delete`, `publish`, `unpublish` and `schedule` now accept `--locale`, the matching `EmDashClient` methods accept a `locale` option, and the MCP tools `content_delete`, `content_publish`, `content_unpublish`, `content_schedule`, `content_unschedule` and `content_discard_draft` accept a `locale` argument, so you can act on another locale's entry by slug.
