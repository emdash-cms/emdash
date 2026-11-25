---
"emdash": patch
"@emdash-cms/admin": patch
---

Changes `GET /_emdash/api/content/{collection}/authors` so it includes each author's `email` only for callers who hold `users:read` (admins), and for API tokens only when they also carry the `admin` scope. Contributors, authors, editors and narrower tokens receive `id`, `name` and `avatarUrl`. The content list's author filter labels an author with no name "Unnamed user".

If you call the exported `handleContentAuthors` directly, it now omits `email` unless you pass `{ includeEmail: true }`.
