---
"@emdash-cms/auth": patch
---

Fixes GitHub OAuth login failing with 403 on accounts where email is private. GitHub's API requires a `User-Agent` header and rejects requests without it.
