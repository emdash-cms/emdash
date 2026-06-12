---
"emdash": minor
"@emdash-cms/admin": minor
---

Add status, author, and date-range filtering to the admin content list (#1288). The content list API gains `authorId`, `dateField`, `dateFrom`, and `dateTo` query params (all additive and optional), and a new `GET /_emdash/api/content/{collection}/authors` endpoint lists the distinct authors of a collection's content (gated on `content:read`). Filtering runs server-side, so it works across the whole collection rather than only the loaded page.
