---
"emdash": patch
---

fix(core/redirects): match exact redirects regardless of trailing slash (#1271)

Exact redirect rules now match requests with or without a trailing slash. A redirect stored with source `/old/` will also match a request for `/old`, and a redirect stored with source `/old` will also match `/old/`. The stored source is preserved unchanged; the fallback happens at lookup time.
