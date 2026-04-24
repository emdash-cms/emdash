---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes three compounding UX failures in the admin collection list (`/_emdash/admin/content/{collection}`):

- **Search** is now server-side. The `GET /_emdash/api/content/{collection}` endpoint accepts a `q` query parameter that does a case-insensitive substring match against `title`, `name`, and `slug`. Previously the admin filtered client-side against only the pages that had already been fetched, so an entry on page 3 of the API was invisible until the user paged forward enough to load it.
- **Column headers sort.** `Title`, `Status`, `Locale`, and `Date` are now clickable, toggle direction, and surface the current direction via `aria-sort`. The server's `orderBy` whitelist now accepts `status`, `locale`, and `name` in addition to the existing date fields.
- **Pagination denominator is stable.** The list response includes a `total` field; the admin uses it as the denominator so it no longer grows in increments of 5 as more API pages are fetched.

The MCP `content_list` tool also accepts `q`, so agents can search without client-side post-filtering.
