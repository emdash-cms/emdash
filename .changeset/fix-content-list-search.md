---
"emdash": patch
"@emdash-cms/admin": patch
---

Make the admin content list search work across the whole collection. Previously the search input filtered `items` already in memory — any entry past the first 100-item API fetch was invisible to search until the user manually paged forward enough to load it.

`GET /_emdash/api/content/{collection}` now accepts a `q` query parameter — a case-insensitive substring match against whichever of `title`, `name`, `slug` actually exist on the collection's table (introspected via `pragma_table_info` / `information_schema.columns`). LIKE wildcards are escaped; input is trimmed and capped at 200 chars.

The admin list debounces the input by 300ms and pushes `q` through the infinite-query key so switching searches resets the cursor chain. `ContentPickerModal` migrated to the same server-side search and uses `keepPreviousData` so the dropdown doesn't flash to empty between keystrokes.

The MCP `content_list` tool also accepts `q`, so agents don't have to post-filter either.
