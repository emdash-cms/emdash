---
"emdash": patch
---

Fixes the admin author filter returning HTTP 500 (`NOT_CONFIGURED` / "EmDash is not initialized") for every collection. The `handleContentAuthors` handler was never exposed on the per-request `locals.emdash` object in middleware, so `GET /_emdash/api/content/{collection}/authors` always tripped its not-initialized guard while sibling content routes worked normally.
