---
"emdash": patch
"@emdash-cms/admin": patch
---

Extend the new server-side content search (`?q=`) to two more surfaces. The `ContentPickerModal` (used when linking content from the editor) now pushes its search box to the server instead of filtering only the items already loaded, so it can find entries anywhere in a large collection; it uses `keepPreviousData` so the list doesn't flash to empty between keystrokes and keeps load-more available while searching. The MCP `content_list` tool also gains a `q` parameter, so agents can search a collection server-side instead of post-filtering a page of results.
