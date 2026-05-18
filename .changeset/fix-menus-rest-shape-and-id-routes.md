---
"emdash": minor
"@emdash-cms/admin": minor
---

Fixes menu REST API consistency:

- **`POST /menus/:name/items` no longer accepts unknown keys silently.** Sending `custom_url` (snake_case) or `url` used to return 201 with `custom_url: null` because Zod's default `.strip()` quietly dropped them. The schemas now use `.strict()` and return **400 `VALIDATION_ERROR`** with `Unrecognized key: "custom_url"`. The documented camelCase keys (`customUrl`, `sortOrder`, `referenceCollection`, etc.) are unchanged and persist as before. The `type` field is now validated against the canonical enum (`"custom" | "page" | "post" | "taxonomy" | "collection"`); previously any string passed.
- **Moves per-item writes to `PUT` and `DELETE /menus/:name/items/:id` (path-style).** Every other EmDash resource (`content`, `taxonomies`, `redirects`, `sections`, `widget-areas`) addresses items by URL path; menus were the lone outlier requiring `?id=<id>` in the query string. The legacy query-string form is **removed** (it was undocumented and only used by the admin, which is updated in this PR). Callers should use `PUT /menus/:name/items/:id` / `DELETE /menus/:name/items/:id`.
- **Menu and menu-item API responses are now camelCase**, aligning with the rest of EmDash's REST surface (`content`, `taxonomies`, `redirects`, …). `created_at` → `createdAt`, `updated_at` → `updatedAt`, `menu_id` → `menuId`, `parent_id` → `parentId`, `sort_order` → `sortOrder`, `reference_collection` → `referenceCollection`, `reference_id` → `referenceId`, `custom_url` → `customUrl`, `title_attr` → `titleAttr`, `css_classes` → `cssClasses`, `translation_group` → `translationGroup`. **Breaking** for direct REST consumers that depend on snake_case keys in the response body. The admin UI is already updated.
- **Refactors menus to the standard repository pattern.** Adds `MenuRepository` next to `ContentRepository`, `TaxonomyRepository`, `RedirectRepository`, `MediaRepository`, `CommentRepository`. Handlers become thin orchestrators; the repository is now the single place where snake_case rows become camelCase entities.

These changes do not touch any database schema or migration. Existing data is preserved.
