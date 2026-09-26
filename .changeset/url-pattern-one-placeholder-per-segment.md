---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes a denial-of-service in public URL routing: a collection URL pattern with several placeholders in one path segment, such as `/{a}{b}{c}{d}{e}x`, let a single crafted request tie up the server for seconds while `resolveEmDashPath()` matched it.

Collection URL patterns now allow at most one placeholder per path segment. `/{year}/{month}/{slug}.html` and `/p-{id}/{slug}` are still valid, but `/{year}{month}/{slug}` and `/{slug}-{id}` are rejected when a collection is created or its pattern is changed through the admin, the REST API, the MCP `schema_update_collection` tool, or a seed. Seed files with such a pattern fail validation before anything is applied. The admin's collection editor shows the problem next to the URL Pattern field.

If a collection already has a pattern that breaks this rule, it keeps working for generating links in menus, sitemaps and redirects, but `resolveEmDashPath()` no longer matches it, and the site logs a warning naming the collection. REST, MCP and admin updates that send the stored pattern back unchanged still succeed. Give each placeholder its own segment (for example, change `/{slug}-{id}` to `/{id}/{slug}`) to route those entries again.
