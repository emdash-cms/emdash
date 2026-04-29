---
"emdash": patch
---

Fixes redirect middleware silently skipping anonymous visitors. The anonymous fast path now exposes `locals.emdash.db`, so admin-defined redirects (exact-match and pattern) fire for logged-out users as the docs imply. Previously the middleware short-circuited on `!emdash?.db` for every public request and the visitor saw a 404 instead of the configured redirect.
