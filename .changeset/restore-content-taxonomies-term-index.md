---
"emdash": patch
---

Restores the `idx_content_taxonomies_term` index on SQLite/D1 installs that lost it when migration 036 was retried after a partial apply, so taxonomy reverse-lookups are indexed again. The index is now recreated unconditionally during 036 to prevent the same loss on any future partial apply.
