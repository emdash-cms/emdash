---
"emdash": patch
---

Fixes silent data loss in migration 036 on Cloudflare D1 (#1021). D1 ignores `PRAGMA foreign_keys = OFF` and its replacement `defer_foreign_keys` only defers constraint validation, it doesn't suppress CASCADE actions, so dropping any table during the i18n rebuild fired its child cascades. Three FK relationships were affected:

- `content_taxonomies.taxonomy_id -> taxonomies(id) ON DELETE CASCADE` wiped all post-taxonomy associations.
- `taxonomies.parent_id -> taxonomies(id) ON DELETE SET NULL` flattened taxonomy hierarchies.
- `_emdash_menu_items.menu_id -> _emdash_menus(id) ON DELETE CASCADE` wiped every menu item on the install (along with `parent_id -> _emdash_menu_items(id) ON DELETE CASCADE` mopping up nested items).

The migration now physically removes those FK relationships before any drop. `content_taxonomies` and `_emdash_menu_items` are rebuilt without their parent FKs as the first steps of up(), and the new `taxonomies` self-FK targets its temporary name (`taxonomies_new`) which SQLite rebinds on RENAME. The FKs from migration 005 on `_emdash_menu_items` are not restored on rollback either: the runtime always deleted child rows explicitly, so the cascade was redundant and reinstating it would only re-create the #1021 hazard on any future migration that drops `_emdash_menus`. Rollback also refuses to run when `content_taxonomies` has rows referencing translation groups with no surviving `taxonomies` row, surfacing dangling data before any destructive work, and the `idx_content_taxonomies_term` index from migration 015 is restored after each rebuild.

This is forward-fix only. Installs that already lost data when running 036 will need to restore from D1 Time Travel.
