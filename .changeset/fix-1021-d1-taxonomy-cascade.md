---
"emdash": patch
---

Fixes silent data loss in migration 036 on Cloudflare D1 (#1021). D1 ignores `PRAGMA foreign_keys = OFF` and its replacement `defer_foreign_keys` only defers constraint validation — it doesn't suppress CASCADE actions — so dropping the old `taxonomies` table during the i18n rebuild fired both the `ON DELETE CASCADE` on `content_taxonomies` (wiping all post-taxonomy associations) and the `ON DELETE SET NULL` on the new table's own `parent_id` (flattening taxonomy hierarchies).

The migration now physically removes those FK relationships before any drop: it rebuilds `content_taxonomies` without the FK as the first step of up(), and points the new `taxonomies` table's self-FK at its temporary name (`taxonomies_new`) which SQLite rebinds on RENAME. The rollback path is restructured to match and now refuses to run when `content_taxonomies` has rows referencing translation groups with no surviving `taxonomies` row, surfacing dangling data before any destructive work. The `idx_content_taxonomies_term` index from migration 015 is also restored after each rebuild (it was previously dropped with the table and never recreated).

This is forward-fix only — installs that already lost data when running 036 will need to restore from D1 Time Travel.
