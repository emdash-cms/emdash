---
"emdash": patch
---

Fixes scheduled cleanup so it deletes expired OAuth access and refresh tokens, OAuth device codes, OAuth authorization codes, and API tokens. Previously these rows stayed in the database forever. API tokens created without an expiry are never deleted, and an expired API token no longer appears in the admin token list once cleanup has run.
