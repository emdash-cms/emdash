---
"emdash": patch
---

Fixes plugin storage cursor pagination returning duplicate rows and skipping others whenever `query()` is called with `orderBy`. The cursor stepped through the `created_at` column while the results were sorted by the requested `data` field, so the two disagreed: paging newest-first re-returned page one and never reached older rows, and paging ascending broke too whenever the sort field did not happen to match insertion order. Pages now seek on the same expression they are sorted by, and `id` is appended as a tiebreaker so a page boundary cannot fall inside a group of equal sort values.

Paginating with a cursor while sorting several fields in different directions now throws `StorageQueryError` instead of silently returning wrong pages. Sort every field the same way, or read the collection without a cursor.
