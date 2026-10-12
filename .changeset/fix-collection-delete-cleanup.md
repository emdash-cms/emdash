---
"emdash": patch
---

Fixes force-deleting a collection so it also removes the entries' records in shared tables: revisions, SEO data, comments, content bylines, taxonomy assignments, entry locks, and the revision prune queue. Previously these rows were left behind because only the content table, FTS table, and collection row were dropped.
