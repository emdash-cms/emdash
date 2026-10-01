---
"emdash": patch
---

Fixes `getEmDashCollection` skipping entries when paging with `nextCursor` while sorted by a field that can be empty, such as `published_at`, `title`, `slug`, or a custom date field, including lists filtered by taxonomy terms. Paging by a boolean field or by a system column such as `version` also returns every entry now. The order of entries is unchanged, and cursors issued before the upgrade are still accepted.
