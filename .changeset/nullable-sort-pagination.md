---
"emdash": patch
---

Fixes content lists skipping entries when paging with `nextCursor` while sorted by a field that can be empty, such as the publish date, scheduled date, title, slug, or a collection's `dateField` or `titleField`. This affected the admin content list for collections with more than 100 entries, including its default sort when the collection sets a `dateField`. It also affected `GET /_emdash/api/content/{collection}`, the MCP `content_list` tool, and plugin `ctx.content.list` calls that set `orderBy`.

The order of entries is unchanged, and cursors issued before the upgrade are still accepted.
