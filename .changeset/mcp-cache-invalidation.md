---
"emdash": patch
---

Fixes MCP write tools leaving cached pages stale on sites with Astro route caching enabled (for example `cacheCloudflare()`). A change made over MCP reached the database, but the cached page kept serving the old copy until its TTL expired. The tools now invalidate the same route-cache tags as the matching REST routes.

#### Content tools

`content_create`, `content_update`, `content_publish`, `content_unpublish`, `content_delete`, `content_restore`, `content_permanent_delete`, `content_schedule`, `content_unschedule`, `content_discard_draft` and `content_duplicate` invalidate the same tags as their REST routes.

A `content_update` that only stages a draft invalidates nothing, as over REST. A `content_update` with a `status` still invalidates when its publish or unpublish step fails, if the update step already changed live content.

#### Taxonomy, menu and settings tools

`taxonomy_create`, `taxonomy_update`, `taxonomy_delete`, `taxonomy_create_term`, `taxonomy_update_term`, `taxonomy_delete_term`, `menu_create`, `menu_update`, `menu_delete`, `menu_set_items` and `settings_update` invalidate their taxonomy, menu or site-settings cache tags.
