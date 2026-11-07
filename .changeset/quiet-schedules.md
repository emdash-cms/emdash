---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds the `no-scheduling` collection support flag to disable creating or changing schedules in the content editor, calendar, and scheduling API. Scheduling remains enabled by default, and existing schedules continue to run and can be removed.

To disable scheduling, add `no-scheduling` to the collection's `supports` in a seed file, or update an existing collection through `PUT /_emdash/api/schema/collections/{slug}` or the `schema_update_collection` MCP tool. For example, a collection with drafts and revisions can use:

```json
{ "supports": ["drafts", "revisions", "no-scheduling"] }
```

Preserve the collection's other support values when updating its list. There is no Content Type editor checkbox for this flag, but saving in that editor preserves it.

If you previously omitted `scheduling` expecting scheduling to be disabled, add `no-scheduling` instead. The legacy `scheduling` value is deprecated and has no effect; it remains accepted for compatibility and can be removed from seed files. If both values are present, `no-scheduling` takes precedence. Sites that want to keep scheduling enabled do not need to change anything.

WordPress imports into a collection with `no-scheduling` keep future-dated posts as drafts and report a scheduling error for each such post.
